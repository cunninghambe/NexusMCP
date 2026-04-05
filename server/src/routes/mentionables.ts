/**
 * GET /api/mentionables
 * Returns all mentionable entities: agents (with keyName as handle) + human users.
 */
import { Router, Request, Response } from "express";
import { db, agents, authUsers } from "../db.js";
import { eq } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler } from "../utils/helpers.js";
import { COMPANY_ID } from "../config.js";

const router = Router();

router.use(authenticate);

export interface Mentionable {
  id: string;
  handle: string;       // The @-mention handle (no @ prefix)
  displayName: string;
  kind: "agent" | "user";
}

router.get(
  "/mentionables",
  asyncHandler(async (_req: Request, res: Response) => {
    // Fetch all agents for this company
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, keyName: agents.keyName })
      .from(agents)
      .where(eq(agents.companyId, COMPANY_ID));

    // Fetch all registered human users
    const userRows = await db
      .select({ id: authUsers.id, name: authUsers.name })
      .from(authUsers);

    const mentionables: Mentionable[] = [
      ...agentRows.map((a) => ({
        id: a.id,
        handle: a.keyName,
        displayName: a.name,
        kind: "agent" as const,
      })),
      ...userRows.map((u) => ({
        id: u.id,
        handle: u.id,          // Use auth user id as handle (e.g. "alice")
        displayName: u.name ?? u.id,
        kind: "user" as const,
      })),
    ];

    res.json(mentionables);
  })
);

export default router;
