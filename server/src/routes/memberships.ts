/**
 * Channel Membership Management Routes
 *
 * Endpoints:
 *   GET    /api/channels/:channelId/members       - List channel members
 *   POST   /api/channels/:channelId/members       - Add member(s) to channel
 *   PATCH  /api/channels/:channelId/members/:memberId - Update member role
 *   DELETE /api/channels/:channelId/members/:memberId - Remove member from channel
 *   DELETE /api/channels/:channelId/members/me    - Leave channel (self-removal)
 *   GET    /api/channels/:channelId/members/me     - Check own membership
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import * as fs from "fs";
import {
  db,
  channels,
  channelMemberships,
  agents as agentsTable,
  authUsers,
  NewChannelMembership,
} from "../db.js";
import { eq, and, isNull, or, inArray } from "drizzle-orm";
import { authenticate, requireCompany } from "../middleware/auth.js";
import { logActivity, paramStr, asyncHandler } from "../utils/helpers.js";
import { COMPANY_ID } from "../config.js";
import { logger } from "../utils/logger.js";

// ── Paperclip agent status lookup ───────────────────────────────────────────

function loadPaperclipApiKey(): string | null {
  if (process.env.PAPERCLIP_API_KEY) return process.env.PAPERCLIP_API_KEY;
  try {
    const configPath = `${process.env.HOME ?? "/root"}/.claude.json`;
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers?.paperclip?.env?.PAPERCLIP_API_KEY ?? null;
  } catch {
    return null;
  }
}

const PAPERCLIP_API_BASE =
  process.env.PAPERCLIP_API_URL ?? "http://localhost:3100/api";

/** Fetch agent statuses keyed by agent ID. Returns empty map on failure. */
async function fetchAgentStatuses(
  agentIds: string[]
): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>();
  if (agentIds.length === 0) return statusMap;

  const apiKey = loadPaperclipApiKey();
  if (!apiKey) return statusMap;

  try {
    const url = `${PAPERCLIP_API_BASE}/companies/${COMPANY_ID}/agents`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return statusMap;

    const data = await response.json();
    const agents: Array<{ id: string; status: string }> = Array.isArray(data)
      ? data
      : Array.isArray(data?.agents)
      ? data.agents
      : [];

    const idSet = new Set(agentIds);
    for (const agent of agents) {
      if (idSet.has(agent.id)) {
        statusMap.set(agent.id, agent.status ?? "idle");
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch agent statuses for member list", { error: String(err) });
  }

  return statusMap;
}

const router = Router();

router.use(authenticate);
router.use(requireCompany(COMPANY_ID));

// --- Validation schemas ---

const addMembersSchema = z.object({
  agentIds: z.array(z.string().uuid()).optional(),
  userIds: z.array(z.string()).optional(),
  role: z.enum(["admin", "member"]).default("member"),
});

const updateMemberSchema = z.object({
  role: z.enum(["admin", "member"]),
});

// --- Helper: verify actor is a channel admin ---
async function requireAdmin(channelId: string, actor: { kind: string; id: string }) {
  const membership = await db.query.channelMemberships.findFirst({
    where: and(
      eq(channelMemberships.channelId, channelId),
      actor.kind === "agent"
        ? eq(channelMemberships.agentId, actor.id)
        : eq(channelMemberships.userId, actor.id),
      isNull(channelMemberships.leftAt)
    ),
  });

  if (!membership) {
    return false;
  }
  if (membership.role !== "admin") {
    return false;
  }
  return true;
}

// --- Helper: check actor is a channel member ---
async function requireMember(channelId: string, actor: { kind: string; id: string }) {
  const membership = await db.query.channelMemberships.findFirst({
    where: and(
      eq(channelMemberships.channelId, channelId),
      actor.kind === "agent"
        ? eq(channelMemberships.agentId, actor.id)
        : eq(channelMemberships.userId, actor.id),
      isNull(channelMemberships.leftAt)
    ),
  });
  return membership;
}

// --- Helper: verify channel exists ---
async function findChannel(channelId: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.companyId, COMPANY_ID),
        isNull(channels.deletedAt)
      )
    )
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================
// GET /api/channels/:channelId/members
// List all current members of a channel (with agent/user names)
// ============================================================
router.get(
  "/:channelId/members",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // For private/group_dm channels, require membership
    if (channel.channelType === "private" || channel.channelType === "group_dm" || channel.channelType === "dm") {
      const membership = await requireMember(channelId, actor);
      if (!membership) {
        res.status(403).json({ error: "Not a member of this channel" });
        return;
      }
    }

    // Get all active memberships with agent/user info
    const memberships = await db
      .select({
        id: channelMemberships.id,
        channelId: channelMemberships.channelId,
        role: channelMemberships.role,
        joinedAt: channelMemberships.joinedAt,
        leftAt: channelMemberships.leftAt,
        agentId: channelMemberships.agentId,
        userId: channelMemberships.userId,
        agentName: agentsTable.name,
        userName: authUsers.name,
        agentKeyName: agentsTable.keyName,
      })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          isNull(channelMemberships.leftAt)
        )
      )
      .leftJoin(
        agentsTable,
        eq(channelMemberships.agentId, agentsTable.id)
      )
      .leftJoin(
        authUsers,
        eq(channelMemberships.userId, authUsers.id)
      );

    // Fetch live statuses for agent members from Paperclip API
    const agentIds = memberships
      .filter((m) => m.agentId != null)
      .map((m) => m.agentId as string);

    const agentStatuses = await fetchAgentStatuses(agentIds);

    const members = memberships.map((m) => {
      const isAgent = m.agentId != null;
      const memberId = isAgent ? m.agentId! : m.userId!;
      const status = isAgent
        ? (agentStatuses.get(m.agentId!) ?? "idle")
        : "online";

      return {
        id: memberId,
        membershipId: m.id,
        channelId: m.channelId,
        role: m.role,
        joinedAt: m.joinedAt,
        kind: isAgent ? "agent" : "user",
        name: m.agentName ?? m.userName ?? "Unknown",
        keyName: m.agentKeyName ?? null,
        status,
      };
    });

    res.json(members);
  })
);

// ============================================================
// GET /api/channels/:channelId/members/me
// Check own membership status in a channel
// ============================================================
router.get(
  "/:channelId/members/me",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const membership = await requireMember(channelId, actor);
    if (!membership) {
      res.status(404).json({ error: "Not a member of this channel" });
      return;
    }

    res.json({
      id: membership.id,
      channelId: membership.channelId,
      role: membership.role,
      joinedAt: membership.joinedAt,
    });
  })
);

// ============================================================
// POST /api/channels/:channelId/members
// Add one or more agents/users to a channel
// ============================================================
router.post(
  "/:channelId/members",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // Require admin to add members
    const isAdmin = await requireAdmin(channelId, actor);
    if (!isAdmin) {
      res.status(403).json({ error: "Only channel admins can add members" });
      return;
    }

    const validation = addMembersSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const { agentIds, userIds, role } = validation.data;
    const added: Array<{ kind: string; id: string }> = [];

    // Add agents
    if (agentIds && agentIds.length > 0) {
      for (const agentId of agentIds) {
        // Check if already a member
        const existing = await db.query.channelMemberships.findFirst({
          where: and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.agentId, agentId),
            isNull(channelMemberships.leftAt)
          ),
        });

        if (existing) {
          continue; // skip already a member
        }

        const agentMemberData: NewChannelMembership = {
          channelId,
          agentId,
          role,
        } as NewChannelMembership;

        const [inserted] = await db
          .insert(channelMemberships)
          .values(agentMemberData)
          .returning();

        added.push({ kind: "agent", id: agentId });
      }
    }

    // Add users
    if (userIds && userIds.length > 0) {
      for (const userId of userIds) {
        const existing = await db.query.channelMemberships.findFirst({
          where: and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, userId),
            isNull(channelMemberships.leftAt)
          ),
        });

        if (existing) {
          continue;
        }

        const userMemberData: NewChannelMembership = {
          channelId,
          userId,
          role,
        } as NewChannelMembership;

        const [inserted] = await db
          .insert(channelMemberships)
          .values(userMemberData)
          .returning();

        added.push({ kind: "user", id: userId });
      }
    }

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.members.added",
      entityType: "channel",
      entityId: channelId,
      details: { added },
    });

    res.status(201).json({ added, total: added.length });
  })
);

// ============================================================
// PATCH /api/channels/:channelId/members/:memberId
// Update a member's role (admin -> member or vice versa)
// ============================================================
router.patch(
  "/:channelId/members/:memberId",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");
    const memberId = paramStr(req, "memberId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // Require admin to update roles
    const isAdmin = await requireAdmin(channelId, actor);
    if (!isAdmin) {
      res.status(403).json({ error: "Only channel admins can update roles" });
      return;
    }

    const validation = updateMemberSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const membership = await db.query.channelMemberships.findFirst({
      where: and(
        eq(channelMemberships.id, memberId),
        eq(channelMemberships.channelId, channelId),
        isNull(channelMemberships.leftAt)
      ),
    });

    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }

    const [updated] = await db
      .update(channelMemberships)
      .set({ role: validation.data.role } as Partial<typeof channelMemberships.$inferInsert>)
      .where(eq(channelMemberships.id, memberId))
      .returning();

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.member.role_updated",
      entityType: "channel",
      entityId: channelId,
      details: { memberId, fromRole: membership.role, toRole: validation.data.role },
    });

    res.json(updated);
  })
);

// ============================================================
// DELETE /api/channels/:channelId/members/:memberId
// Remove a specific member from a channel (admin action)
// ============================================================
router.delete(
  "/:channelId/members/:memberId",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");
    const memberId = paramStr(req, "memberId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // Require admin to remove others
    const isAdmin = await requireAdmin(channelId, actor);
    if (!isAdmin) {
      res.status(403).json({ error: "Only channel admins can remove members" });
      return;
    }

    const membership = await db.query.channelMemberships.findFirst({
      where: and(
        eq(channelMemberships.id, memberId),
        eq(channelMemberships.channelId, channelId),
        isNull(channelMemberships.leftAt)
      ),
    });

    if (!membership) {
      res.status(404).json({ error: "Membership not found or already removed" });
      return;
    }

    // Soft-delete by setting leftAt
    const [updated] = await db
      .update(channelMemberships)
      .set({ leftAt: new Date() } as Partial<typeof channelMemberships.$inferInsert>)
      .where(eq(channelMemberships.id, memberId))
      .returning();

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.member.removed",
      entityType: "channel",
      entityId: channelId,
      details: { memberId, removedBy: actor.id },
    });

    res.json({ success: true });
  })
);

// ============================================================
// DELETE /api/channels/:channelId/members/me
// Leave channel (self-removal)
// ============================================================
router.delete(
  "/:channelId/members/me",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    const channel = await findChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const membership = await requireMember(channelId, actor);
    if (!membership) {
      res.status(404).json({ error: "Not a member of this channel" });
      return;
    }

    // Only admins can leave channels they created (prevent lone channel orphaning)
    // For simplicity, allow anyone to leave

    await db
      .update(channelMemberships)
      .set({ leftAt: new Date() } as Partial<typeof channelMemberships.$inferInsert>)
      .where(eq(channelMemberships.id, membership.id));

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.member.left",
      entityType: "channel",
      entityId: channelId,
      details: { leftBy: actor.id },
    });

    res.json({ success: true });
  })
);

export default router;
