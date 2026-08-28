"use strict";
/**
 * Mongo connect for CLI scripts, with the SRV/DNS fallback these machines need.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A `mongodb+srv://` URI needs an SRV record lookup, and SRV goes through
 * Node's bundled c-ares resolver — NOT the OS resolver that ordinary hostname
 * lookups use. When c-ares cannot read the system DNS configuration (Windows
 * commonly advertises placeholder IPv6 resolvers like fec0:0:0:ffff::1 that
 * nothing answers on), every SRV query is refused and the driver dies with:
 *
 *     querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
 *
 * which reads like a database or credentials fault and is neither — Windows
 * itself resolves the very same name correctly.
 *
 * server.js handles this for the running app, and scripts/grantRefereeRegister
 * grew its own copy. This is that logic in one place so the next script does
 * not have to rediscover it. ~57 scripts under scripts/ still call
 * mongoose.connect directly and will fail on such a machine; they can be
 * migrated to this helper as they are touched.
 *
 *   const { connectDb, disconnectDb } = require("./lib/connectDb");
 *   await connectDb();
 */
const mongoose = require("mongoose");
const dns = require("dns");

// Public resolvers, used only after the system's own lookup has failed.
const FALLBACK_DNS = (process.env.DNS_SERVERS || "1.1.1.1,8.8.8.8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DNS_FAILURE = /querySrv|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEOUT|EAI_NODATA/i;

/**
 * Connect using MONGO_URI (or an explicit uri), retrying once through public
 * resolvers if — and only if — the failure looks like DNS. A genuine auth or
 * network error is rethrown untouched rather than retried pointlessly.
 */
async function connectDb(uri = process.env.MONGO_URI, opts = {}) {
  if (!uri) throw new Error("MONGO_URI is not set. Check server/.env");

  const options = { serverSelectionTimeoutMS: 20000, ...opts };

  try {
    return await mongoose.connect(uri, options);
  } catch (err) {
    if (!DNS_FAILURE.test(err.message || "")) throw err;

    console.warn(
      `[db] SRV lookup failed (${err.message})\n` +
        `[db] retrying via ${FALLBACK_DNS.join(", ")} — set DNS_SERVERS to override`
    );
    dns.setServers(FALLBACK_DNS);
    return await mongoose.connect(uri, options);
  }
}

async function disconnectDb() {
  try {
    await mongoose.disconnect();
  } catch (err) {
    console.warn(`[db] disconnect failed: ${err.message}`);
  }
}

module.exports = { connectDb, disconnectDb, FALLBACK_DNS };
