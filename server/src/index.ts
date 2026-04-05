/**
 * Slack-for-AI Platform Server
 * REST API for channels, messaging, reactions, memberships + WebSocket real-time layer.
 */
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { parse } from "url";
import { v4 as uuidv4 } from "uuid";
import { pool } from "./db.js";
import { attachWebSocket, broadcastToChannel } from "./websocket.js";
import channelsRouter from "./routes/channels.js";
import messagesRouter from "./routes/messages.js";
import reactionsRouter from "./routes/reactions.js";
import membershipsRouter from "./routes/memberships.js";
import companyMembershipsRouter from "./routes/company-memberships.js";
import healthRouter from "./routes/health.js";
import metricsRouter from "./routes/metrics.js";
import mcpRouter from "./routes/mcp.js";
import uploadsRouter from "./routes/uploads.js";
import { receiptsRouter } from "./routes/receipts.js";
import channelMembershipRouter from "./routes/channel-membership.js";
import agentsRouter from "./routes/agents.js";
import mentionablesRouter from "./routes/mentionables.js";
import searchRouter from "./routes/search.js";
import loginRouter from "./routes/login.js";
import { requestMetrics, errorTracker, rateLimiter } from "./middleware/monitoring.js";
import { correlationId } from "./middleware/correlation.js";
import { logger } from "./utils/logger.js";

const app = express();
const PORT = process.env.PORT ?? 3200;

// Create HTTP server first so we can attach WebSocket
const httpServer = createServer(app);

app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Monitoring & Observability ──────────────────────────────
// 1. Correlation ID (runs first so all subsequent middleware has access)
app.use(correlationId);

// 2. Request metrics / structured logging
app.use(requestMetrics);

// 3. Rate limiting on all API routes (generous defaults for agent traffic)
app.use("/api", rateLimiter({ windowMs: 60_000, maxRequests: 500 }));

// ─── Health Checks ───────────────────────────────────────────
app.use("/api/health", healthRouter);

// ─── Metrics ─────────────────────────────────────────────────
app.use("/api/metrics", metricsRouter);

// Legacy health endpoint (redirects to new route)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "slack-for-ai", port: PORT });
});

// ─── Auth Routes (no auth required) ──────────────────────────
app.use("/api/auth", loginRouter);

// ─── REST Route Mounting ────────────────────────────────────
app.use("/api/channels", channelsRouter);
app.use("/api/channels", messagesRouter);
app.use("/api", searchRouter);
app.use("/api/channels", receiptsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api", mentionablesRouter);
app.use("/api/messages", reactionsRouter);

// ─── Membership Routes ──────────────────────────────
// GET    /api/channels/:channelId/members       - List members
// POST   /api/channels/:channelId/members       - Add member(s)
// PATCH  /api/channels/:channelId/members/:id   - Update member role
// DELETE /api/channels/:channelId/members/:id   - Remove member
// DELETE /api/channels/:channelId/members/me    - Leave channel
app.use("/api/channels", membershipsRouter);

// ─── Company-Scoped Membership Routes ────────────────
// GET    /api/companies/:companyId/channels/:channelId/members        - List members
// POST   /api/companies/:companyId/channels/:channelId/members        - Add agent to channel
// DELETE /api/companies/:companyId/channels/:channelId/members/:agentId - Remove agent from channel
app.use("/api/companies/:companyId/channels", companyMembershipsRouter);

// ─── Channel Membership Routes (direct /api/memberships/... paths) ──
// GET    /api/memberships/channels/:channelId          - List members
// GET    /api/memberships/channels/:channelId/agents/:agentId - Check membership
// POST   /api/memberships/channels/:channelId          - Add agent to channel
// DELETE /api/memberships/channels/:channelId/agents/:agentId - Remove agent
app.use("/api/memberships", channelMembershipRouter);

app.use("/api", uploadsRouter);

// ─── WebSocket Server (Real-Time Messaging) ──────────────
attachWebSocket(httpServer);

// ─── Error Handling ──────────────────────────────────────────
// 404 catch-all for unmatched API routes
app.use("/api/*", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// Global error handler (structured logging + correlation IDs)
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const correlationId = (req as express.Request & { correlationId?: string }).correlationId;
    logger.errorEvent("Unhandled error", {
      errorId: `${Date.now()}`,
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      correlationId,
    });
    if (!res.headersSent) {
      res.status(500).json({
        error: "Internal server error",
        ...(correlationId ? { correlationId } : {}),
      });
    }
  }
);

// ─── Process-Level Error Handling ─────────────────────────────
// Catch uncaught exceptions (prevents silent crashes)
process.on("uncaughtException", (err: Error) => {
  const errorId = `${Date.now()}-uncaught`;
  logger.error("Uncaught exception", {
    errorId,
    message: err.message,
    stack: err.stack,
  });
  // Attempt graceful shutdown after logging
  setTimeout(() => process.exit(1), 2000).unref();
});

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason: unknown) => {
  const errorId = `${Date.now()}-rejection`;
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error("Unhandled promise rejection", {
    errorId,
    message,
    stack,
  });
});

// Handle SIGTERM for graceful shutdown (in addition to the SIGINT handler below)
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal, shutting down gracefully");
  shutdown();
});

// ─── Start Server ────────────────────────────────────────────
const server = httpServer.listen(PORT, () => {
  logger.info("Slack-for-AI server started", {
    port: PORT,
    rest_api: `http://localhost:${PORT}/api`,
    websocket: `ws://localhost:${PORT}/ws`,
    health: `http://localhost:${PORT}/health`,
    metrics: `http://localhost:${PORT}/api/metrics`,
    environment: process.env.NODE_ENV ?? "development",
  });
});

async function shutdown() {
  logger.info("Shutting down server");

  // Close all WebSocket connections gracefully (handled by websocket.ts module)

  server.close();
  pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
