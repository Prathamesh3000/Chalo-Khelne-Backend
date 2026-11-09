// Authorized serving of the /uploads tree.
//
// This replaces a single `app.use("/uploads", express.static(uploadsDir))`,
// which served EVERY upload category with no authentication at all — including
// identity-docs (PAN cards, licences), certificates and private group-chat
// attachments. Anyone holding a filename, logged in or not, could fetch the
// file; there was no expiry, no ownership check and no revocation.
//
// The tree is now split by policy rather than by location, so nothing has to be
// moved on disk and no production data needs migrating:
//
//   PUBLIC_DIRS  → served statically, as before (avatars, tournament banners…)
//   PRIVATE_DIRS → authenticated + per-category ownership check, streamed
//   anything else → 404 (no fallthrough to the uploads root)

const express = require("express");
const path = require("path");
const fs = require("fs");

const { authenticate } = require("./authMiddleware");
const GroupChatMessage = require("../src/modules/social/models/GroupChatMessage");
const User = require("../src/modules/identity/models/User");
const Referee = require("../src/modules/catalog/models/Referee");
const Trainer = require("../src/modules/org/models/Trainer");

const PUBLIC_DIRS = [
  "profiles",
  "stories",
  "turfs",
  "tournaments",
  "events",
  "equipment",
  "qrcodes",
  "posts",
  "history",
];

const PRIVATE_DIRS = [
  "identity-docs",
  "certificates",
  "group-chat",
  // Payment proofs (§2.5) — screenshots of a player's UPI/bank confirmation.
  // Readable by the player who submitted it and the manager reviewing it.
  "payment-proofs",
];

// Content types we are willing to emit. Anything else is sent as a download
// rather than rendered, so an unexpected file can never execute in the origin.
const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const INLINE_RENDERABLE = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf",
]);

const REVIEWER_ROLES = new Set([
  "superadmin",
  "clubadmin",
  "corporate_admin",
  "manager",
]);

function roleOf(req) {
  return String(req.user?.role || "").toLowerCase();
}

function callerId(req) {
  return String(req.user?.id || req.user?._id || req.user?.userId || "");
}

// ── Per-category authorization ──────────────────────────────────────────────

// Certificates exist to be reviewed, so the owning professional and any
// reviewing role may read them. Everyone else is refused.
async function mayReadCertificate(req, relPath) {
  if (REVIEWER_ROLES.has(roleOf(req))) return true;

  const me = callerId(req);
  if (!me) return false;

  const [referee, trainer] = await Promise.all([
    Referee.exists({ userId: me, "certificates.certificateUrl": relPath }),
    Trainer.exists({ userId: me, "certificates.certificateUrl": relPath }),
  ]);
  return Boolean(referee || trainer);
}

// Identity documents are the most sensitive thing in the tree. Owner or
// SuperAdmin only — a Manager has no business reading a player's PAN card.
async function mayReadIdentityDoc(req, relPath) {
  if (roleOf(req) === "superadmin") return true;

  const me = callerId(req);
  if (!me) return false;

  return Boolean(
    await User.exists({ _id: me, "identityDocument.path": relPath })
  );
}

// A chat attachment is readable by the members of the chat it was posted in.
async function mayReadChatAttachment(req, relPath) {
  const me = callerId(req);
  if (!me) return false;

  const message = await GroupChatMessage.findOne({
    "attachments.url": relPath,
  })
    .select("chatId")
    .lean();
  if (!message) return false;

  const { canJoinGroupChat } = require("../utils/chatMembership");
  return canJoinGroupChat(me, message.chatId);
}

// A payment proof is readable by exactly two parties: the player who submitted
// it and the manager it was submitted to. A proof is the evidence behind a
// money decision, so nobody else — including other managers — gets to see it.
async function mayReadPaymentProof(req, relPath) {
  const me = callerId(req);
  if (!me) return false;
  if (roleOf(req) === "superadmin") return true;

  const PlayerPayment = require("../src/modules/commerce/models/playerPaymentSchema");
  return Boolean(
    await PlayerPayment.exists({
      screenshot: relPath,
      $or: [{ playerId: me }, { managerId: me }],
    })
  );
}

const AUTHORIZERS = {
  certificates: mayReadCertificate,
  "identity-docs": mayReadIdentityDoc,
  "group-chat": mayReadChatAttachment,
  "payment-proofs": mayReadPaymentProof,
};

// ── Router ──────────────────────────────────────────────────────────────────

module.exports = function serveUploads(uploadsDir) {
  const router = express.Router();

  const staticOpts = {
    // Never let a static handler negotiate a type we did not intend, and never
    // let a browser sniff one.
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
    // Do not fall through to the next handler on a miss — a miss is a 404.
    fallthrough: false,
    index: false,
    dotfiles: "deny",
  };

  for (const dir of PUBLIC_DIRS) {
    router.use(
      `/${dir}`,
      express.static(path.join(uploadsDir, dir), staticOpts)
    );
  }

  for (const dir of PRIVATE_DIRS) {
    router.get(`/${dir}/:filename`, authenticate, async (req, res) => {
      // basename() collapses any traversal attempt (`..%2f..%2fetc%2fpasswd`
      // decodes to a path before it reaches us) to a bare filename.
      const filename = path.basename(req.params.filename);
      const ext = path.extname(filename).toLowerCase();

      if (!CONTENT_TYPES[ext]) {
        return res.status(404).json({ message: "Not found" });
      }

      const relPath = `uploads/${dir}/${filename}`;
      let allowed = false;
      try {
        allowed = await AUTHORIZERS[dir](req, relPath);
      } catch (err) {
        console.error(`[uploads] authorization error for ${relPath}:`, err);
        return res.status(500).json({ message: "Error retrieving file" });
      }

      // 404 rather than 403: a 403 confirms the file exists, which is itself a
      // disclosure on a tree of PII.
      if (!allowed) return res.status(404).json({ message: "Not found" });

      const filepath = path.join(uploadsDir, dir, filename);
      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ message: "Not found" });
      }

      res.setHeader("Content-Type", CONTENT_TYPES[ext]);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader(
        "Content-Disposition",
        `${INLINE_RENDERABLE.has(ext) ? "inline" : "attachment"}; filename="${filename}"`
      );

      fs.createReadStream(filepath)
        .on("error", () => {
          if (!res.headersSent) res.status(404).end();
        })
        .pipe(res);
    });
  }

  // ── Legacy root-level files ────────────────────────────────────────────────
  // Some uploads land directly in the uploads root rather than a category dir:
  // multer's destination switch has no case for `qrCodes` or `substitute`, so
  // they fall through to `cb(null, uploadsDir)`. Those files are referenced by
  // stored paths in ManagerPayment.qrCodes[].imageUrl and on substitute
  // records, and they are public content by nature (a payment QR code exists to
  // be scanned). Serve bare filenames from the root so existing records keep
  // resolving — but ONLY a single path segment with a known extension, so this
  // can never reach into a private category directory.
  router.get(/^\/[^/\\]+$/, (req, res, next) => {
    const filename = path.basename(decodeURIComponent(req.path));
    const ext = path.extname(filename).toLowerCase();
    if (!CONTENT_TYPES[ext]) return next();

    const filepath = path.join(uploadsDir, filename);
    // Confirm the resolved path really is a direct child of uploadsDir.
    if (path.dirname(path.resolve(filepath)) !== path.resolve(uploadsDir)) {
      return next();
    }
    if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
      return next();
    }

    res.setHeader("Content-Type", CONTENT_TYPES[ext]);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${INLINE_RENDERABLE.has(ext) ? "inline" : "attachment"}; filename="${filename}"`
    );
    fs.createReadStream(filepath)
      .on("error", () => {
        if (!res.headersSent) res.status(404).end();
      })
      .pipe(res);
  });

  // Any path not claimed above — including the uploads root listing, the dead
  // `forum` attachment directory, and anything else that used to be exposed by
  // the blanket static handler — is a 404.
  router.use((_req, res) => res.status(404).json({ message: "Not found" }));

  return router;
};

module.exports.PUBLIC_DIRS = PUBLIC_DIRS;
module.exports.PRIVATE_DIRS = PRIVATE_DIRS;
// Exported so the legacy /api/auth/certificates/:filename route enforces the
// identical rule instead of settling for "any authenticated user".
module.exports.AUTHORIZERS = AUTHORIZERS;
