import { Router, Request, Response } from "express";
import { z } from "zod";
import { db, channels, messages, channelMemberships, messageReactions, agents, NewMessage, NewReaction } from "../db.js";
import { eq, and, isNull, desc, sql, inArray, type SQL } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";
import { broadcastToChannel } from "../websocket.js";
import { logActivity, getNextSequenceNum, paramStr, asyncHandler } from "../utils/helpers.js";
import { COMPANY_ID } from "../config.js";
import { parseMentions, wakeupAgent } from "../utils/paperclip.js";

const router = Router();

router.use(authenticate);

// Validation schemas
const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000).optional(),
  messageType: z.enum(["plain", "structured", "system"]).default("plain"),
  structuredPayload: z.record(z.unknown()).optional(),
  parentId: z.string().uuid().optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

/**
 * GET /api/channels/:channelId/messages - Get message history
 * Query params: limit (default 50), before (sequence number), parentId (for threads)
 */
router.get(
  "/:channelId/messages",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    // Verify channel exists
    const channelRows = await db
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

    if (channelRows.length === 0) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const channel = channelRows[0];

    // For private channels, verify membership
    if (channel.channelType === "private" || channel.channelType === "group_dm") {
      const membershipRows = await db
        .select()
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            actor.kind === "agent"
              ? eq(channelMemberships.agentId, actor.id)
              : eq(channelMemberships.userId, actor.id),
            isNull(channelMemberships.leftAt)
          )
        )
        .limit(1);

      if (membershipRows.length === 0) {
        res.status(403).json({ error: "Not a member of this channel" });
        return;
      }
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;
    const parentId = req.query.parentId as string | undefined;

    const whereClauses: SQL<unknown>[] = [
      eq(messages.channelId, channelId),
      isNull(messages.deletedAt),
    ];

    if (before) {
      whereClauses.push(
        sql`${messages.sequenceNum} < ${Number(before)}`
      );
    }

    if (parentId) {
      whereClauses.push(eq(messages.parentId, parentId));
    } else {
      whereClauses.push(isNull(messages.parentId));
    }

    const messageList = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        parentId: messages.parentId,
        senderAgentId: messages.senderAgentId,
        senderUserId: messages.senderUserId,
        content: messages.content,
        messageType: messages.messageType,
        structuredPayload: messages.structuredPayload,
        edited: messages.edited,
        editedAt: messages.editedAt,
        pinned: messages.pinned,
        pinnedAt: messages.pinnedAt,
        sequenceNum: messages.sequenceNum,
        replyCount: messages.replyCount,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .where(and(...whereClauses))
      .orderBy(desc(messages.sequenceNum))
      .limit(limit);

    // Fetch reactions for all messages and attach to each message
    const messageIds = messageList.map((m) => m.id);
    let reactions: typeof messageReactions.$inferSelect[] = [];
    if (messageIds.length > 0) {
      reactions = await db.select().from(messageReactions).where(inArray(messageReactions.messageId, messageIds));
    }

    // Group reactions by messageId and emoji
    const reactionsByMessage = new Map<
      string,
      Map<string, { emoji: string; count: number; agentIds: string[]; userIds: string[] }>
    >()
    for (const r of reactions) {
      let emojiMap = reactionsByMessage.get(r.messageId)
      if (!emojiMap) {
        emojiMap = new Map()
        reactionsByMessage.set(r.messageId, emojiMap)
      }
      let grp = emojiMap.get(r.emoji)
      if (!grp) {
        grp = { emoji: r.emoji, count: 0, agentIds: [], userIds: [] }
        emojiMap.set(r.emoji, grp)
      }
      grp.count++
      if (r.agentId) grp.agentIds.push(r.agentId)
      if (r.userId) grp.userIds.push(r.userId)
    }

    // Attach reactions to messages
    const messagesWithReactions = messageList.map((m) => ({
      ...m,
      reactions: reactionsByMessage.get(m.id)
        ? Array.from(reactionsByMessage.get(m.id)!.values())
        : [],
    }))

    res.json({
      messages: messagesWithReactions.reverse(),
      hasMore: messagesWithReactions.length >= limit,
    });
  })
);

/**
 * POST /api/channels/:channelId/messages - Send a message
 */
router.post(
  "/:channelId/messages",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const channelId = paramStr(req, "channelId");

    const validation = sendMessageSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const { content, messageType, structuredPayload, parentId } = validation.data;

    // Verify channel exists
    const channelRows = await db
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

    if (channelRows.length === 0) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const channel = channelRows[0];

    // For private channels, verify membership
    if (channel.channelType === "private" || channel.channelType === "group_dm") {
      const membershipRows = await db
        .select()
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            actor.kind === "agent"
              ? eq(channelMemberships.agentId, actor.id)
              : eq(channelMemberships.userId, actor.id),
            isNull(channelMemberships.leftAt)
          )
        )
        .limit(1);

      if (membershipRows.length === 0) {
        res.status(403).json({ error: "Not a member of this channel" });
        return;
      }
    }

    // If parentId provided, verify it exists
    const parentMessages = parentId
      ? await db
          .select()
          .from(messages)
          .where(and(eq(messages.id, parentId), eq(messages.channelId, channelId)))
          .limit(1)
      : [];

    if (parentId && parentMessages.length === 0) {
      res.status(404).json({ error: "Parent message not found" });
      return;
    }

    const sequenceNum = await getNextSequenceNum(channelId, parentId ?? null);

    const messageData: NewMessage = {
      channelId,
      parentId: parentId ?? null,
      senderAgentId: actor.kind === "agent" ? actor.id : null,
      senderUserId: actor.kind === "user" ? actor.id : null,
      content: content ?? null,
      messageType,
      structuredPayload: structuredPayload ?? null,
      sequenceNum,
    } as NewMessage;

    const inserted = await db
      .insert(messages)
      .values(messageData)
      .returning();

    const newMessage = inserted[0];

    // Update parent's reply count if this is a thread reply
    if (parentId) {
      await db
        .update(messages)
        .set({
          replyCount: sql`${messages.replyCount} + 1`,
        } as Partial<typeof messages.$inferInsert>)
        .where(eq(messages.id, parentId));
    }

    // Broadcast the new message to all WebSocket subscribers of this channel
    broadcastToChannel(channelId, { message: newMessage });

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "message.sent",
      entityType: "message",
      entityId: newMessage.id,
      details: { channelId, parentId: parentId ?? null },
    });

    // Parse @mentions and wake up any mentioned agents (fire-and-forget)
    if (content) {
      const mentionedHandles = parseMentions(content);
      if (mentionedHandles.length > 0) {
        // Look up agents whose keyName matches any mentioned handle
        const mentionedAgents = await db
          .select({ id: agents.id, keyName: agents.keyName })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, COMPANY_ID),
              inArray(agents.keyName, mentionedHandles)
            )
          );

        // Determine sender display name for the wakeup reason
        const senderName =
          actor.kind === "agent"
            ? actor.keyName ?? actor.id
            : actor.id;

        const messagePreview =
          content.length > 120 ? content.slice(0, 117) + "..." : content;

        for (const agent of mentionedAgents) {
          // Fire-and-forget: errors are caught inside wakeupAgent
          wakeupAgent(
            agent.id,
            `You were mentioned in NexusMCP channel #${channel.name} by ${senderName}: ${messagePreview}`
          );
        }
      }
    }

    res.status(201).json(newMessage);
  })
);

/**
 * GET /api/channels/:channelId/messages/:id - Get a single message
 */
router.get(
  "/:channelId/messages/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = paramStr(req, "id");

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), isNull(messages.deletedAt)))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    res.json(rows[0]);
  })
);

/**
 * PATCH /api/channels/:channelId/messages/:id - Edit a message
 */
router.patch(
  "/:channelId/messages/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const id = paramStr(req, "id");

    const validation = editMessageSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(422).json({
        error: "Validation failed",
        details: validation.error.flatten(),
      });
      return;
    }

    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), isNull(messages.deletedAt)))
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const msg = existing[0];

    // Only sender can edit
    if (
      (actor.kind === "agent" && msg.senderAgentId !== actor.id) ||
      (actor.kind === "user" && msg.senderUserId !== actor.id)
    ) {
      res.status(403).json({ error: "Not authorized to edit this message" });
      return;
    }

    const updated = await db
      .update(messages)
      .set({
        content: validation.data.content,
        edited: true,
        editedAt: new Date(),
      } as Partial<typeof messages.$inferInsert>)
      .where(eq(messages.id, id))
      .returning();

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "message.edited",
      entityType: "message",
      entityId: id,
    });

    res.json(updated[0]);
  })
);

/**
 * DELETE /api/channels/:channelId/messages/:id - Soft delete a message
 */
router.delete(
  "/:channelId/messages/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const id = paramStr(req, "id");

    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), isNull(messages.deletedAt)))
      .limit(1);

    if (existing.length === 0) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const msg = existing[0];

    // Only sender can delete
    if (
      (actor.kind === "agent" && msg.senderAgentId !== actor.id) ||
      (actor.kind === "user" && msg.senderUserId !== actor.id)
    ) {
      res.status(403).json({ error: "Not authorized to delete this message" });
      return;
    }

    await db
      .update(messages)
      .set({
        deleted: true,
        deletedAt: new Date(),
        deletedByAgentId: actor.kind === "agent" ? actor.id : null,
        deletedByUserId: actor.kind === "user" ? actor.id : null,
      } as Partial<typeof messages.$inferInsert>)
      .where(eq(messages.id, id));

    await logActivity({
      actor,
      companyId: COMPANY_ID,
      action: "message.deleted",
      entityType: "message",
      entityId: id,
    });

    res.json({ success: true });
  })
);

export default router;
