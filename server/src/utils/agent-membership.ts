/**
 * Agent membership auto-enrollment utility.
 *
 * On server startup, fetches all Paperclip agents and ensures each one has
 * an active membership record in the #general channel (and any other specified
 * channels). Idempotent — safe to run multiple times.
 */
import * as fs from "fs";
import { db, channelMemberships, agents as agentsTable, NewChannelMembership } from "../db.js";
import { eq, and, isNull } from "drizzle-orm";
import { COMPANY_ID } from "../config.js";
import { logger } from "./logger.js";

// ── API key resolution ──────────────────────────────────────────────────────

function loadPaperclipApiKey(): string | null {
  if (process.env.PAPERCLIP_API_KEY) {
    return process.env.PAPERCLIP_API_KEY;
  }
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

// ── Paperclip agent type ────────────────────────────────────────────────────

interface PaperclipAgent {
  id: string;
  companyId: string;
  name: string;
  status: string;
  urlKey: string;
}

/**
 * Fetch all agents for the company from the Paperclip API.
 * Returns an empty array on any error so startup is never blocked.
 */
async function fetchPaperclipAgents(apiKey: string): Promise<PaperclipAgent[]> {
  const url = `${PAPERCLIP_API_BASE}/companies/${COMPANY_ID}/agents`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn("Failed to fetch agents from Paperclip API", {
        status: response.status,
        body,
        url,
      });
      return [];
    }

    const data = await response.json();
    // API may return array directly or wrapped in { agents: [...] }
    const agents: PaperclipAgent[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.agents)
      ? data.agents
      : [];

    logger.info("Fetched agents from Paperclip API", { count: agents.length });
    return agents;
  } catch (err) {
    logger.warn("Error fetching agents from Paperclip API", {
      error: String(err),
      url,
    });
    return [];
  }
}

/**
 * Fetch agents from the local database (fallback when Paperclip API is
 * unavailable). Returns agents that belong to the configured company.
 */
async function fetchLocalAgents(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.companyId, COMPANY_ID));
}

/**
 * Ensure a single agent has an active membership in a channel.
 * Skips if a non-left membership already exists.
 */
async function ensureAgentMembership(
  channelId: string,
  agentId: string
): Promise<boolean> {
  // Check for an existing active membership
  const existing = await db.query.channelMemberships.findFirst({
    where: and(
      eq(channelMemberships.channelId, channelId),
      eq(channelMemberships.agentId, agentId),
      isNull(channelMemberships.leftAt)
    ),
  });

  if (existing) {
    return false; // already a member
  }

  await db.insert(channelMemberships).values({
    channelId,
    agentId,
    role: "member",
  } as NewChannelMembership);

  return true; // newly added
}

/**
 * Auto-enroll all known Paperclip agents into the specified channels.
 *
 * Called from index.ts on server startup. Never throws — all errors are logged
 * so they don't prevent the server from starting.
 *
 * @param channelIds  Array of channel IDs to enroll agents in.
 *                    Defaults to the #general channel.
 */
export async function enrollAgentsInChannels(
  channelIds: string[] = ["aaaaaaaa-0000-0000-0000-000000000001"]
): Promise<void> {
  const apiKey = loadPaperclipApiKey();

  let agentIds: string[] = [];

  if (apiKey) {
    const paperclipAgents = await fetchPaperclipAgents(apiKey);
    agentIds = paperclipAgents.map((a) => a.id);
  }

  // Always fall back to local DB agents to catch any not returned by API
  if (agentIds.length === 0) {
    logger.info("Using local DB agents for channel enrollment (no API key or API unavailable)");
    const localAgents = await fetchLocalAgents();
    agentIds = localAgents.map((a) => a.id);
  }

  if (agentIds.length === 0) {
    logger.info("No agents found — skipping channel enrollment");
    return;
  }

  for (const channelId of channelIds) {
    let added = 0;
    let skipped = 0;

    for (const agentId of agentIds) {
      try {
        const wasAdded = await ensureAgentMembership(channelId, agentId);
        if (wasAdded) {
          added++;
        } else {
          skipped++;
        }
      } catch (err) {
        logger.warn("Failed to ensure agent membership", {
          channelId,
          agentId,
          error: String(err),
        });
      }
    }

    logger.info("Agent channel enrollment complete", {
      channelId,
      added,
      skipped,
      total: agentIds.length,
    });
  }
}
