/**
 * Bootstrap — connects DB, creates HTTP(S) server, attaches Socket.io.
 * Express wiring lives in app.js. Route registry lives in routes/index.js.
 */

require("dotenv").config();

// ── Fail fast on missing/weak critical env (runs before any other module) ──
const { validateEnv } = require("./Config/validateEnv");
validateEnv();

// Route all console.* through winston (structured levels + timestamps). Must
// run before other modules load so their logs are captured too.
const { patchConsole } = require("./utils/logger");
patchConsole();

// ── DNS resolver guard (must run before the Mongo connect) ────────────
// Stops `querySrv ECONNREFUSED` on machines where Node's SRV resolver falls
// back to 127.0.0.1. Shared with the one-off scripts — see utils/dnsGuard.js.
require("./utils/dnsGuard");

// Optional error tracking (no-op unless SENTRY_DSN set + @sentry/node installed).
const { initSentry, captureException } = require("./utils/sentry");
initSentry();

const mongoose = require("mongoose");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { Server } = require("socket.io");

const { createApp } = require("./app");
const setupSocket = require("./socket/socketHandler");
const { startAllCrons } = require("./cron/startCrons");

const app = createApp();

// ── SSL (production only) ─────────────────────────────────────────────
let sslOptions = null;
const useSSL = process.env.USE_SSL === "true" && process.env.NODE_ENV === "production";

if (useSSL) {
  const certPath = process.env.SSL_CERT_PATH || "/etc/letsencrypt/live/dev.bestowalsystems.in/fullchain.pem";
  const keyPath = process.env.SSL_KEY_PATH || "/etc/letsencrypt/live/dev.bestowalsystems.in/privkey.pem";
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      secureProtocol: "TLS_method",
      ciphers: [
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES128-SHA256",
        "ECDHE-RSA-AES256-SHA384",
      ].join(":"),
      honorCipherOrder: true,
    };
    console.log("SSL certificates loaded");
  } else {
    console.warn(`SSL certs not found — starting HTTP. cert=${certPath} key=${keyPath}`);
  }
}

// ── Mongo ─────────────────────────────────────────────────────────────
// Runtime connection events (reconnect handled automatically by the driver).
mongoose.connection.on("error", (err) => console.error("[MONGO] runtime error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("[MONGO] disconnected"));
mongoose.connection.on("reconnected", () => console.log("[MONGO] reconnected"));

mongoose
  .connect(process.env.MONGO_URI, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    console.log("MongoDB connected");
    // Background cron jobs. Single-instance (default): the web process owns them.
    // Multi-instance (Phase 2 HA): set RUN_CRON=false on every web instance and
    // run worker.js as the ONE cron owner, so jobs don't double-fire.
    if (process.env.RUN_CRON !== "false") {
      startAllCrons();
    } else {
      console.log("[cron] RUN_CRON=false — crons delegated to the worker process");
    }
  })
  .catch((err) => {
    console.error("FATAL: MongoDB connection failed:", err.message);
    process.exit(1);
  });

// ── Listen ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3003;

const server = sslOptions
  ? https.createServer(sslOptions, app)
  : http.createServer(app);

server.listen(PORT, () => {
  const proto = sslOptions ? "https" : "http";
  const host = sslOptions ? "dev.bestowalsystems.in" : "localhost";
  console.log(`${proto.toUpperCase()} Server running on ${proto}://${host}:${PORT}`);
  if (!sslOptions && process.env.NODE_ENV === "production") {
    console.warn("WARNING: Running HTTP server in production mode!");
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────
// Render / k8s send SIGTERM before killing a pod. Drain HTTP first so
// in-flight requests finish, then close Mongo cleanly. Hard-exit after
// 30s as a safety net for stuck connections.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — draining...`);
  const forceExit = setTimeout(() => {
    console.error("[shutdown] forced exit (drain timeout)");
    process.exit(1);
  }, 30_000);
  forceExit.unref();
  server.close((err) => {
    if (err) console.error("[shutdown] server.close error:", err.message);
    mongoose.connection
      .close(false)
      .then(() => {
        console.log("[shutdown] mongo closed. bye.");
        clearTimeout(forceExit);
        process.exit(err ? 1 : 0);
      })
      .catch((e) => {
        console.error("[shutdown] mongo close error:", e.message);
        process.exit(1);
      });
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Last-resort process guards ─────────────────────────────────────────
// asyncHandler (utils/asyncHandler) converts route-level throws/rejections into
// clean 500s, so these should rarely fire. When they DO, process state may be
// unreliable — log loudly and shut down GRACEFULLY (drain HTTP + close Mongo)
// so the process manager (PM2) restarts a fresh instance. We never silently
// swallow the error, and never exit instantly without cleanup.
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
  captureException(reason instanceof Error ? reason : new Error("Unhandled rejection: " + String(reason)), { kind: "unhandledRejection" });
  shutdown("unhandledRejection");
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  captureException(err, { kind: "uncaughtException" });
  shutdown("uncaughtException");
});

// ── Sockets ───────────────────────────────────────────────────────────
// Match the HTTP CORS policy: native mobile sends no origin (allowed); browser
// origins must be allowlisted via WEB_ALLOWED_ORIGINS. Fail closed in production.
const _socketOrigins = (process.env.WEB_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (_socketOrigins.length > 0) return cb(null, _socketOrigins.includes(origin));
      if (process.env.NODE_ENV === "production") return cb(null, false);
      return cb(null, true);
    },
    credentials: true,
  },
});
// Attach the Redis adapter when REDIS_URL is set (multi-instance fan-out);
// otherwise no-op → default in-memory adapter (single-instance, unchanged).
const { attachRedisAdapter } = require("./utils/socketAdapter");
attachRedisAdapter(io);
app.set("io", io);
setupSocket(io);
console.log("[SOCKET] Socket.io initialized");
