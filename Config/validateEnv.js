/**
 * Fail-fast environment validation (run once at startup, before anything else).
 *
 * Philosophy:
 *   - REQUIRED vars have no safe default → missing one aborts boot.
 *   - REQUIRED_IN_PROD vars are only enforced when NODE_ENV=production.
 *   - RECOMMENDED vars only warn (so local/dev boot still works) but the
 *     related feature will silently fail without them.
 *   - Known weak/placeholder/compromised values (e.g. admin:admin Mongo creds,
 *     "your-secret-key" reset secret) are flagged — FATAL in production,
 *     a loud warning in dev — to force rotation.
 *
 * IMPORTANT: only list variables the server code actually reads. Do NOT add
 * vars the app never consumes (e.g. RAZORPAY_*, FIREBASE_*, CLOUDINARY_* are
 * not wired into the server) — requiring them would block boot for no reason.
 */
"use strict";

// No safe default — server cannot function without these.
const REQUIRED = ["MONGO_URI", "JWT_SECRET"];

// Enforced only in production.
const REQUIRED_IN_PROD = [
  "WEB_ALLOWED_ORIGINS", // CORS allow-list; dev allows localhost, prod must be explicit
];

// Strongly recommended — feature degrades/fails silently if unset.
const RECOMMENDED = [
  "JWT_RESET_SECRET", // password-reset tokens (passwordReset.js)
  "EMAIL_USER", // nodemailer sender
  "EMAIL_APP_PASSWORD", // nodemailer auth
  "FRONTEND_URL", // links embedded in outgoing emails
  // Apple token revocation on account deletion (App Store Guideline 5.1.1(v)).
  // Without these the deletion still succeeds but the Apple token is NOT
  // revoked, which Apple also requires. Must be set before the iOS release.
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
];

// Patterns that indicate a leftover placeholder / known-weak / compromised value.
const WEAK_PATTERNS = {
  JWT_SECRET: [/^your[-_]?secret/i, /^changeme$/i, /^secret$/i],
  JWT_RESET_SECRET: [/^your[-_]?secret[-_]?key$/i, /^changeme$/i],
  MONGO_URI: [/\/\/admin:admin@/i, /\/\/root:root@/i, /\/\/[^:@/]+:password@/i],
};

function validateEnv() {
  const isProd = process.env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  const isBlank = (k) => !process.env[k] || !String(process.env[k]).trim();

  for (const key of REQUIRED) {
    if (isBlank(key)) errors.push(`Missing required env var: ${key}`);
  }
  for (const key of REQUIRED_IN_PROD) {
    if (isProd && isBlank(key)) {
      errors.push(`Missing required env var (production): ${key}`);
    } else if (isBlank(key)) {
      warnings.push(`${key} not set — fine in dev, REQUIRED in production.`);
    }
  }
  for (const key of RECOMMENDED) {
    if (isBlank(key)) warnings.push(`Recommended env var not set: ${key} (related feature will not work).`);
  }

  // Minimum strength for the signing secret.
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    (isProd ? errors : warnings).push(
      "JWT_SECRET should be at least 32 characters of high-entropy randomness."
    );
  }

  // Weak / placeholder / compromised value detection.
  for (const [key, patterns] of Object.entries(WEAK_PATTERNS)) {
    const val = process.env[key];
    if (val && patterns.some((re) => re.test(val))) {
      const msg = `${key} looks like a weak/placeholder/compromised value — ROTATE it.`;
      (isProd ? errors : warnings).push(msg);
    }
  }

  if (warnings.length) {
    console.warn("⚠️  Environment warnings:");
    warnings.forEach((w) => console.warn(`   - ${w}`));
  }
  if (errors.length) {
    console.error("❌ Environment validation failed — server will not start:");
    errors.forEach((e) => console.error(`   - ${e}`));
    console.error("   See .env.example for the full list of required variables.");
    process.exit(1);
  }
  console.log("✅ Environment validation passed.");
}

module.exports = { validateEnv, REQUIRED, REQUIRED_IN_PROD, RECOMMENDED };
