/**
 * Paperclip platform integration utilities.
 * Handles server-to-server calls to the Paperclip API.
 */
import * as fs from "fs";
import { logger } from "./logger.js";

// Read the Paperclip API key from env var, or fall back to reading ~/.claude.json
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

const paperclipApiKey = loadPaperclipApiKey();

/**
 * Send a wakeup ping to a Paperclip agent.
 * Fire-and-forget — errors are logged but never thrown so message delivery is unaffected.
 */
export async function wakeupAgent(
  agentId: string,
  reason: string
): Promise<void> {
  if (!paperclipApiKey) {
    logger.warn("PAPERCLIP_API_KEY not found — skipping wakeup", { agentId });
    return;
  }

  const url = `${PAPERCLIP_API_BASE}/agents/${agentId}/wakeup`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${paperclipApiKey}`,
      },
      body: JSON.stringify({ reason }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn("Paperclip wakeup returned non-OK status", {
        agentId,
        status: response.status,
        body,
      });
    } else {
      logger.info("Paperclip wakeup sent", { agentId, reason });
    }
  } catch (err) {
    // Never crash message delivery over a wakeup failure
    logger.warn("Paperclip wakeup request failed", {
      agentId,
      error: String(err),
    });
  }
}

/**
 * Parse @mention handles from message content.
 * Returns an array of unique handle strings (without the @ prefix).
 */
export function parseMentions(content: string): string[] {
  const matches = content.matchAll(/@([a-zA-Z0-9_-]+)/g);
  const handles = new Set<string>();
  for (const m of matches) {
    handles.add(m[1]);
  }
  return Array.from(handles);
}
