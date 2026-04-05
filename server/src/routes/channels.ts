import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  db,
  channels,
  channelMemberships,
  channelReadReceipts,
  messages,
  agents,
  NewChannel,
  NewChannelMembership,
} from "../db.js";
import { eq, and, isNull, asc, sql, gt, count as drizzleCount, inArray } from "drizzle-orm";
import { authenticate, requireCompany } from "../middleware/auth.js";
import { logActivity, paramStr, asyncHandler } from "../utils/helpers.js";
import { COMPANY_ID } from "../config.js";

const router = Router();

// Validation schemas
const createChannelSchema = z.object({
  name: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).optional(),
  channelType: z.enum(["public", "private", "dm", "group_dm"]).default("public"),
  memberAgentIds: z.array(z.string().uuid()).optional(),
  memberUserIds: z.array(z.string()).optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(500).optional(),
  channelType: z.enum(["public", "private", "dm", "group_dm"]).optional(),
  archived: z.boolean().optional(),
});

// Apply auth middleware
router.use(authenticate);
router.use(requireCompany(COMPANY_ID));

// GET /api/channels - List accessible channels with unread counts
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = (req as any).actor;

    // Basic channel listing
    const channelResults = await db
      .select({
        id: channels.id,
        name: channels.name,
        slug: channels.slug,
        channelType: channels.channelType,
        description: channels.description,
        archived: channels.archived,
        createdAt: channels.createdAt,
        updatedAt: channels.updatedAt,
      })
      .from(channels)
      .where(
        and(
          eq(channels.companyId, COMPANY_ID),
          isNull(channels.deletedAt),
          eq(channels.archived, false)
        )
      )
      .orderBy(asc(channels.name));

    const results = channelResults as any[];

    // If actor is authenticated, enrich with unreadCount
    if (actor && results.length > 0) {
      const channelIds = results.map((ch: any) => ch.id);

      // Get membership info for unread calculation
      const membershipCond = actor.kind === "agent"
        ? and(
            eq(channelMemberships.agentId, actor.id),
            isNull(channelMemberships.leftAt)
          )
        : and(
            eq(channelMemberships.userId, actor.id),
            isNull(channelMemberships.leftAt)
          );

      const memberships = await db
        .select({ channelId: channelMemberships.channelId })
        .from(channelMemberships)
        .where(membershipCond);

      const memberChannelIds = new Set(memberships.map((m: any) => m.channelId));

      // Get read receipts
      const receiptCond = actor.kind === "agent"
        ? and(
            inArray(channelReadReceipts.channelId, channelIds),
            eq(channelReadReceipts.agentId, actor.id)
          )
        : and(
            inArray(channelReadReceipts.channelId, channelIds),
            eq(channelReadReceipts.userId, actor.id)
          );

      const receipts = await db
        .select({
          channelId: channelReadReceipts.channelId,
          lastReadAt: channelReadReceipts.lastReadAt,
        } as any)
        .from(channelReadReceipts)
        .where(receiptCond);

      const readAtMap = new Map<string, Date>();
      for (const r of receipts) {
        readAtMap.set(r.channelId, r.lastReadAt as any);
      }

      // For each channel, compute unreadCount
      for (const ch of results) {
        if (!memberChannelIds.has(ch.id)) {
          ch.unreadCount = 0;
          continue;
        }

        const lastReadAt = readAtMap.get(ch.id);
        const whereParts: any[] = [
          eq(messages.channelId, ch.id),
          isNull(messages.deletedAt),
        ];
        if (lastReadAt) {
          whereParts.push(gt(messages.createdAt, lastReadAt));
        }
        const msgCount = await db
          .select({ cnt: drizzleCount() })
          .from(messages)
          .where(and(...whereParts));

        ch.unreadCount = msgCount[0]?.cnt ?? 0;
      }
    } else {
      for (const ch of results) {
        ch.unreadCount = 0;
      }
    }

    // Enrich with memberCount for all channels
    if (results.length > 0) {
      const allChannelIds = results.map((ch: any) => ch.id);
      const memberCounts = await db
        .select({
          channelId: channelMemberships.channelId,
          cnt: drizzleCount(),
        })
        .from(channelMemberships)
        .where(
          and(
            inArray(channelMemberships.channelId, allChannelIds),
            isNull(channelMemberships.leftAt)
          )
        )
        .groupBy(channelMemberships.channelId);

      const countMap = new Map(memberCounts.map((r: any) => [r.channelId, r.cnt]));
      for (const ch of results) {
        ch.memberCount = countMap.get(ch.id) ?? 0;
      }
    }

    res.json(results);
  })
);

// GET /api/channels/:id - Get channel details
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = paramStr(req, "id");

    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, id),
          eq(channels.companyId, COMPANY_ID),
          isNull(channels.deletedAt)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const channel = rows[0];

    // Get memberships
    const memberships = await db
      .select({
        role: channelMemberships.role,
        joinedAt: channelMemberships.joinedAt,
        leftAt: channelMemberships.leftAt,
        agentId: channelMemberships.agentId,
        userId: channelMemberships.userId,
      })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, channel.id));

    res.json({ ...channel, memberships });
  })
);

// POST /api/channels - Create a channel
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const validation = createChannelSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const { name, description, channelType, memberAgentIds, memberUserIds } =
      validation.data;
    const slug = name.toLowerCase();

    const channelData: NewChannel = {
      companyId: COMPANY_ID,
      name,
      slug,
      channelType,
      description: description ?? null,
      creatorAgentId: actor.kind === "agent" ? actor.id : null,
      creatorUserId: actor.kind === "user" ? actor.id : null,
    } as NewChannel;

    const inserted = await db
      .insert(channels)
      .values(channelData)
      .returning();

    const newChannel = inserted[0];

    // Add creator as admin
    const memberData: NewChannelMembership = {
      channelId: newChannel.id,
      agentId: actor.kind === "agent" ? actor.id : null,
      userId: actor.kind === "user" ? actor.id : null,
      role: "admin",
    } as NewChannelMembership;
    await db.insert(channelMemberships).values(memberData);

    // Add specified members for private channels
    if (channelType === "private" || channelType === "group_dm") {
      const membershipInserts: NewChannelMembership[] = [];

      if (memberAgentIds) {
        for (const agentId of memberAgentIds) {
          membershipInserts.push({
            channelId: newChannel.id,
            agentId,
            role: "member",
          } as NewChannelMembership);
        }
      }

      if (memberUserIds) {
        for (const userId of memberUserIds) {
          membershipInserts.push({
            channelId: newChannel.id,
            userId,
            role: "member",
          } as NewChannelMembership);
        }
      }

      if (membershipInserts.length > 0) {
        await db.insert(channelMemberships).values(membershipInserts);
      }
    }

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.created",
      entityType: "channel",
      entityId: newChannel.id,
      details: { name, channelType },
    });

    res.status(201).json(newChannel);
  })
);

// POST /api/channels/dm - Find or create a DM channel
router.post(
  "/dm",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const { targetAgentId, targetUserId } = req.body;

    if (!targetAgentId && !targetUserId) {
      res.status(422).json({ error: "targetAgentId or targetUserId required" });
      return;
    }

    // Check if DM channel already exists between these two actors
    const existingChannels = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, COMPANY_ID),
          eq(channels.channelType, "dm"),
          isNull(channels.deletedAt)
        )
      );

    for (const ch of existingChannels) {
      const members = await db
        .select()
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, ch.id),
            isNull(channelMemberships.leftAt)
          )
        );

      const actorId = actor.id;
      const targetId = targetAgentId || targetUserId;
      const memberIds = members.map((m) => m.agentId || m.userId);

      if (
        members.length === 2 &&
        memberIds.includes(actorId) &&
        memberIds.includes(targetId)
      ) {
        res.json(ch);
        return;
      }
    }

    // Create new DM channel
    const slug = `dm-${Date.now()}`;

    const dmChannelData: NewChannel = {
      companyId: COMPANY_ID,
      name: slug,
      slug,
      channelType: "dm",
      creatorAgentId: actor.kind === "agent" ? actor.id : null,
      creatorUserId: actor.kind === "user" ? actor.id : null,
    } as NewChannel;

    const [newChannel] = await db
      .insert(channels)
      .values(dmChannelData)
      .returning();

    // Add both members
    const dmMemberA: NewChannelMembership = {
      channelId: newChannel.id,
      agentId: actor.kind === "agent" ? actor.id : null,
      userId: actor.kind === "user" ? actor.id : null,
      role: "member",
    } as NewChannelMembership;
    const dmMemberB: NewChannelMembership = {
      channelId: newChannel.id,
      agentId: targetAgentId || null,
      userId: targetUserId || null,
      role: "member",
    } as NewChannelMembership;
    await db.insert(channelMemberships).values([dmMemberA, dmMemberB]);

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.dm_created",
      entityType: "channel",
      entityId: newChannel.id,
      details: { targetAgentId, targetUserId },
    });

    res.status(201).json(newChannel);
  })
);

// PATCH /api/channels/:id - Update channel
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const id = paramStr(req, "id");

    const validation = updateChannelSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, id),
          eq(channels.companyId, COMPANY_ID),
          isNull(channels.deletedAt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const updateData: {
      name?: string;
      slug?: string;
      description?: string;
      channelType?: string;
      archived?: boolean;
    } = {};

    if (validation.data.name !== undefined) {
      updateData.name = validation.data.name;
      updateData.slug = validation.data.name.toLowerCase();
    }
    if (validation.data.description !== undefined) {
      updateData.description = validation.data.description;
    }
    if (validation.data.channelType !== undefined) {
      updateData.channelType = validation.data.channelType;
    }
    if (validation.data.archived !== undefined) {
      updateData.archived = validation.data.archived;
    }

    const updated = await db
      .update(channels)
      .set(updateData)
      .where(eq(channels.id, id))
      .returning();

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "channel.updated",
      entityType: "channel",
      entityId: id,
      details: validation.data,
    });

    res.json(updated[0]);
  })
);

export default router;
