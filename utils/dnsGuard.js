"use strict";
// ── DNS resolver guard (must run before any mongodb+srv:// connect) ──────
//
// A `mongodb+srv://` URI needs an SRV record lookup, and SRV goes through
// Node's bundled c-ares resolver — NOT the OS resolver that plain hostname
// lookups (dns.lookup) use. When c-ares cannot read the system DNS
// configuration, it falls back to a hard-coded 127.0.0.1. Nothing is listening
// on port 53 there, so every SRV query is refused and the driver dies with:
//
//   querySrv ECONNREFUSED _mongodb._tcp...
//
// which reads like a database or credentials fault and is neither — Windows
// itself resolves the very same name correctly.
//
// The `['127.0.0.1']` list is c-ares' give-up sentinel, so treating it as the
// trigger is precise: a machine with real resolvers configured never matches,
// and this is inert in production. DNS_SERVERS overrides the fallback list.
//
// Lives here rather than in server.js so one-off scripts get it too: they
// connect with the same URI and failed the same way, while the server — which
// had the guard inline — connected fine on the same machine.
//
// Applied on require. Load it AFTER dotenv, so a DNS_SERVERS set in .env counts.
const dns = require("dns");

function applyDnsGuard() {
  const resolvers = dns.getServers();
  if (resolvers.length === 1 && (resolvers[0] === "127.0.0.1" || resolvers[0] === "::1")) {
    const fallback = (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
      .split(",").map((s) => s.trim()).filter(Boolean);
    dns.setServers(fallback);
    console.warn(
      `[dns] Resolver was ${resolvers[0]} with nothing listening — SRV lookups ` +
      `would fail. Falling back to ${fallback.join(", ")}. Set DNS_SERVERS to override.`
    );
    return fallback;
  }
  return null;
}

applyDnsGuard();

module.exports = { applyDnsGuard };
