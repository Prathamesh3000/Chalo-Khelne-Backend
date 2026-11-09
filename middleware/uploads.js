const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Create directories with proper paths.
// UPLOADS_DIR lets ops point this at a mounted persistent disk (Render) without
// touching code; defaults to <server>/uploads so dev/local is unchanged.
const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, "..", "uploads");
const profilesDir = path.join(uploadsDir, "profiles");
const certificatesDir = path.join(uploadsDir, "certificates");
const identityDocsDir = path.join(uploadsDir, "identity-docs");
const tournamentsDir = path.join(uploadsDir, "tournaments");
const eventsDir = path.join(uploadsDir, "events");
const turfsDir = path.join(uploadsDir, "turfs");
const storiesDir = path.join(uploadsDir, "stories");
const equipmentDir = path.join(uploadsDir, "equipment");
// Social post photos and player-history (timeline) photos. Public, like stories.
const postsDir = path.join(uploadsDir, "posts");
const historyDir = path.join(uploadsDir, "history");
// Payment-proof screenshots (§2.5). PRIVATE — these are financial evidence
// showing a player's UPI app, reference and often their name/handle. Served
// only through the authenticated handler in serveUploads.js.
const paymentProofsDir = path.join(uploadsDir, "payment-proofs");
// Create upload path
const uploadPath = path.join(process.cwd(), "uploads/qrcodes");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

// Ensure directories exist
[
  uploadsDir,
  profilesDir,
  certificatesDir,
  identityDocsDir,
  tournamentsDir,
  eventsDir,
  turfsDir,
  storiesDir,
  equipmentDir,
  postsDir,
  historyDir,
  paymentProofsDir,
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
});

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const ALLOWED_CERTIFICATE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/webp",
  "application/pdf",
  "application/msword",                                                    // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  // "application/octet-stream" is still accepted (React Native genuinely sends
  // it) but it is NO LONGER a way to pick your own extension — see
  // safeExtension() below, which only ever writes an extension from
  // EXTENSION_ALLOWLIST regardless of what the client declares or names.
  "application/octet-stream",
];

// ── Stored extension is derived, never taken from the client ────────────────
// Previously the stored name used path.extname(file.originalname) verbatim.
// Combined with the octet-stream escape hatch above, a file named payload.html
// was written as .html and later served as text/html from the API origin (CSP
// is disabled) — stored XSS. The stored extension now comes from the declared
// MIME type, and for octet-stream from the original extension ONLY if that
// extension is itself on the allowlist. Anything unrecognised becomes .bin.
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

const EXTENSION_ALLOWLIST = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".doc", ".docx",
]);

function safeExtension(file) {
  const mapped = MIME_TO_EXT[file.mimetype];
  if (mapped) return mapped;

  // octet-stream (or anything else that slipped past the filter): fall back to
  // the client's extension only when it is on the allowlist. ".html", ".svg",
  // ".js" and friends are not, so they can never be written.
  const claimed = path.extname(file.originalname || "").toLowerCase();
  if (EXTENSION_ALLOWLIST.has(claimed)) return claimed === ".jpeg" ? ".jpg" : claimed;

  return ".bin";
}

const ALLOWED_IDENTITY_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  "image/jpg",
];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Check fieldname to determine destination
    if (file.fieldname === "tournamentLogo") {
      cb(null, tournamentsDir);
    } else if (
      file.fieldname === "profile-image" ||
      file.fieldname === "cover-image"
    ) {
      cb(null, profilesDir);
    } else if (file.fieldname === "certificate") {
      cb(null, certificatesDir);
    } else if (file.fieldname === "identity-document") {
      cb(null, identityDocsDir);
    } else if (file.fieldname === "playerImages") {
      // Handle player images for events
      cb(null, eventsDir);
    } else if (file.fieldname === "turfImages") {
      // Handle turf images
      cb(null, turfsDir);
    } else if (file.fieldname === "storyImage") {
      cb(null, storiesDir);
    } else if (file.fieldname === "equipmentImages") {
      cb(null, equipmentDir);
    } else if (file.fieldname === "postImages") {
      cb(null, postsDir);
    } else if (file.fieldname === "historyImages") {
      cb(null, historyDir);
    } else if (file.fieldname === "screenshot") {
      // Payment proof (§2.5) — private directory.
      cb(null, paymentProofsDir);
    } else {
      cb(null, uploadsDir);
    }
  },
  filename: function (req, file, cb) {
    // crypto-random, not Date.now()+Math.random(): these names are the only
    // thing standing between a private file and a lucky guess.
    const uniqueSuffix =
      Date.now() + "-" + crypto.randomBytes(12).toString("hex");
    cb(null, file.fieldname + "-" + uniqueSuffix + safeExtension(file));
  },
});

const fileFilter = (req, file, cb) => {
  if (
    file.fieldname === "tournamentLogo" ||
    file.fieldname === "playerImages" ||
    file.fieldname === "turfImages" ||
    file.fieldname === "qrCodes" ||
    file.fieldname === "storyImage" ||
    file.fieldname === "equipmentImages" ||
    file.fieldname === "postImages" ||
    file.fieldname === "historyImages"
  ) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Invalid file type for images"), false);
    }
    cb(null, true);
  } else if (
    file.fieldname === "profile-image" ||
    file.fieldname === "cover-image"
  ) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Invalid image type"), false);
    }
    cb(null, true);
  } else if (file.fieldname === "certificate") {
    if (!ALLOWED_CERTIFICATE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Invalid certificate type"), false);
    }
    cb(null, true);
  } else if (file.fieldname === "screenshot") {
    // Payment proof: an image of the player's UPI/bank confirmation. Images
    // only — a PDF or Word "receipt" is not what this flow reviews.
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)
        && file.mimetype !== "application/octet-stream") {
      return cb(new Error("Payment proof must be an image"), false);
    }
    cb(null, true);
  } else if (file.fieldname === "identity-document") {
    if (!ALLOWED_IDENTITY_TYPES.includes(file.mimetype)) {
      return cb(new Error("Invalid identity document type"), false);
    }
    cb(null, true);
  } else {
    cb(new Error("Invalid field name"), false);
  }
};
// Create multer instance
const uploadMiddleware = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    // 15MB. Modern phone photos routinely exceed 5MB; when they did, multer
    // aborted the request mid-stream and the client saw "Network request
    // failed" instead of a clean error. 15MB covers real-world camera images.
    fileSize: 15 * 1024 * 1024,
  },
});

module.exports = {
  uploadMiddleware,
  uploadsDir,
  tournamentsDir,
  profilesDir,
  certificatesDir,
  identityDocsDir,
  eventsDir,
  turfsDir,
  storiesDir,
  equipmentDir,
  postsDir,
  historyDir,
  paymentProofsDir,
  cleanupFile: async (filePath) => {
    try {
      if (filePath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (error) {
      console.error("Error cleaning up file:", error);
    }
  },
  // Convert absolute file path to a relative path from the uploads directory
  // e.g. "D:\project\server\uploads\profiles\img.jpg" → "profiles/img.jpg"
  getRelativePath: (absolutePath) => {
    return path.relative(uploadsDir, absolutePath).replace(/\\/g, "/");
  },
};
