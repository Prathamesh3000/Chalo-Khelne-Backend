/**
 * Vendor ACCOUNT management (role "vendor") — SuperAdmin "Create Vendor" flow.
 *
 * Distinct from controllers/vendorController.js (affiliate links on /api/equipment).
 *
 * - Save as Draft  → VendorProfile{status:"draft"}, NO User, NO email.
 * - Create Account → VendorProfile{status:"active"} + User{role:"vendor"} + a
 *   set-password invite email (no plaintext password — Day-1 policy).
 * - Promoting a draft to "active" later (via PATCH) creates the User + emails then.
 * Status workflow: draft / pending_verification / active / suspended / rejected /
 * deactivated. Only "active" lets the vendor log in (mapped to User.status).
 *
 * Phase 1: data + status workflow. Document/branding UPLOADS are a Phase-2 pass.
 */
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const User = require("../src/modules/identity/models/User");
const VendorProfile = require("../src/modules/commerce/models/VendorProfile");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  // .env uses EMAIL_APP_PASSWORD (the Gmail app password); EMAIL_PASS is the
  // legacy name. Fall back so the transporter authenticates either way.
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS || process.env.EMAIL_APP_PASSWORD },
});

function callerSuperadminId(req) {
  return req.superadminId || req.user?.userId || req.user?.id || req.user?._id || null;
}

// Profile fields a SuperAdmin may set on create/update (NOT userId/status/createdBy).
const ADMIN_FIELDS = [
  "businessName", "businessType", "ownerName", "phone", "email",
  "address", "location",
  "gstNumber", "panNumber", "businessRegNumber", "licenseNumber", "documentsVerified",
  "sportsCategories", "productCategories",
  "businessModel", "deliveryOptions", "paymentSettlement", "commissionPercent",
  "username", "credentialDelivery", "permissions",
  "description", "storeHighlights", "workingHours", "inventory",
  "isPlatformVendor",
];

// Fields a vendor may edit on their own profile (business-facing only).
const VENDOR_SELF_FIELDS = [
  "businessName", "ownerName", "phone", "address", "location",
  "sportsCategories", "productCategories", "description", "storeHighlights",
  "workingHours", "businessType",
];

function assign(target, body, fields) {
  for (const k of fields) {
    if (body[k] !== undefined) target[k] = body[k];
  }
}

function sendWelcomeEmail(profile) {
  const loginLink = `${process.env.FRONTEND_URL || "https://chalokhelne.com"}/login`;
  transporter.sendMail(
    {
      from: process.env.EMAIL_USER,
      to: profile.email,
      subject: "Welcome to Chalo Khelne — Vendor Account",
      text:
        `Hello ${profile.ownerName},\n\n` +
        `A vendor account for "${profile.businessName}" has been created on Chalo Khelne.\n\n` +
        `To set your password, open the login page and use "Forgot Password" with this email:\n${profile.email}\n\n` +
        `Login here: ${loginLink}\n\n` +
        `Best Regards,\nChalo Khelne Team`,
    },
    (err, info) => {
      if (err) console.error("[VENDOR] welcome email failed:", err.message);
      else console.log("[VENDOR] welcome email sent:", info.response);
    }
  );
}

// Create the login User for a vendor profile and link it. Caller saves the profile.
async function createVendorUser(profile) {
  const tempPassword = crypto.randomBytes(12).toString("hex"); // never sent; User hook hashes it
  const user = new User({
    name: profile.ownerName,
    email: profile.email,
    mobile: profile.phone || "0000000000",
    // The shared User model requires dateOfBirth (a player field). Vendors are
    // businesses with no DOB, so we store a neutral placeholder to satisfy
    // validation (resolves to an adult; not used anywhere for vendors).
    dateOfBirth: new Date("1970-01-01"),
    password: tempPassword,
    role: "vendor",
    status: "active",
    isApproved: true,
    emailVerified: true,
  });
  await user.save();
  profile.userId = user._id;

  // 7-day trial on the vendor plan. Non-fatal — a billing hiccup must not
  // block account creation.
  const { grantTrialSafe } = require("../services/subscriptionService");
  await grantTrialSafe({ subjectId: user._id, subjectType: "vendor" });

  return user;
}

// ── SuperAdmin: create vendor (draft OR active account) ──────────────────
exports.createVendor = async (req, res) => {
  try {
    const isDraft = req.body.draft === true || req.body.status === "draft";
    const { businessName, ownerName, email } = req.body;

    if (!businessName || !ownerName || !email) {
      return res.status(400).json({
        success: false,
        message: "businessName, ownerName and email are required",
      });
    }
    const normalizedEmail = String(email).toLowerCase().trim();

    const profile = new VendorProfile({ createdBy: callerSuperadminId(req) });
    assign(profile, req.body, ADMIN_FIELDS);
    profile.email = normalizedEmail;

    if (isDraft) {
      profile.status = "draft";
      profile.userId = null;
      await profile.save();
      return res.status(201).json({ success: true, message: "Draft saved.", data: profile });
    }

    // Active account — must not collide with an existing user.
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ success: false, message: "A user with this email already exists." });
    }

    await createVendorUser(profile);
    profile.status = "active";
    // First active vendor becomes the platform vendor (receives product uploads).
    const hasPlatform = await VendorProfile.exists({ isPlatformVendor: true });
    if (!hasPlatform) profile.isPlatformVendor = true;
    await profile.save();
    sendWelcomeEmail(profile);

    return res.status(201).json({
      success: true,
      message: "Vendor created. A set-password email was sent.",
      data: profile,
    });
  } catch (error) {
    console.error("[VENDOR_CREATE] error:", error);
    return res.status(500).json({ success: false, message: "Failed to create vendor", error: error.message });
  }
};

// ── SuperAdmin: list ─────────────────────────────────────────────────────
exports.listVendors = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const rx = { $regex: String(req.query.search).trim(), $options: "i" };
      filter.$or = [{ businessName: rx }, { ownerName: rx }, { email: rx }];
    }

    const [vendors, total] = await Promise.all([
      VendorProfile.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      VendorProfile.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: vendors,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("[VENDOR_LIST] error:", error);
    return res.status(500).json({ success: false, message: "Failed to list vendors", error: error.message });
  }
};

// ── SuperAdmin: detail ─────────────────────────────────────────────────────
exports.getVendor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id" });
    }
    const vendor = await VendorProfile.findById(id).lean();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });
    const account = vendor.userId
      ? await User.findById(vendor.userId).select("name email mobile role status").lean()
      : null;
    return res.status(200).json({ success: true, data: { ...vendor, account } });
  } catch (error) {
    console.error("[VENDOR_GET] error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch vendor", error: error.message });
  }
};

// ── SuperAdmin: update (edit fields + status workflow) ─────────────────────
exports.updateVendor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id" });
    }
    const vendor = await VendorProfile.findById(id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });

    assign(vendor, req.body, ADMIN_FIELDS);
    if (req.body.email) vendor.email = String(req.body.email).toLowerCase().trim();
    // Only one platform vendor — promoting this one demotes the rest.
    if (req.body.isPlatformVendor === true) {
      await VendorProfile.updateMany({ _id: { $ne: vendor._id } }, { isPlatformVendor: false });
    }

    // Status workflow transition.
    if (req.body.status && VendorProfile.STATUSES.includes(req.body.status)) {
      const newStatus = req.body.status;
      vendor.status = newStatus;

      if (newStatus === "active") {
        if (!vendor.userId) {
          // Promote a draft → create the login account + send the invite now.
          const existing = await User.findOne({ email: vendor.email });
          if (existing) {
            return res.status(409).json({ success: false, message: "A user with this email already exists." });
          }
          await createVendorUser(vendor);
          sendWelcomeEmail(vendor);
        } else {
          await User.findByIdAndUpdate(vendor.userId, { status: "active" });
        }
      } else if (vendor.userId) {
        // Any non-active workflow state blocks login.
        await User.findByIdAndUpdate(vendor.userId, { status: "suspended" });
      }
    }

    await vendor.save();
    return res.status(200).json({ success: true, message: "Vendor updated", data: vendor });
  } catch (error) {
    console.error("[VENDOR_UPDATE] error:", error);
    return res.status(500).json({ success: false, message: "Failed to update vendor", error: error.message });
  }
};

// ── SuperAdmin: set a temporary password and reveal it ONCE ──────────────
// For cases where the set-password email can't be received (dummy/bouncing
// inbox) or for quick testing. The admin shares the temp password out-of-band.
exports.resetVendorPassword = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id" });
    }
    const vendor = await VendorProfile.findById(id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });
    if (!vendor.userId) {
      return res.status(400).json({ success: false, message: "This vendor has no login account yet. Create the account first." });
    }
    const user = await User.findById(vendor.userId);
    if (!user) return res.status(404).json({ success: false, message: "Vendor account not found" });

    // Readable temp password, e.g. "Vnd-7a3f9c21".
    const tempPassword = `Vnd-${crypto.randomBytes(4).toString("hex")}`;
    user.password = tempPassword; // User pre-save hook hashes it
    user.status = "active";       // ensure the account can log in
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Temporary password set",
      data: { email: vendor.email, tempPassword },
    });
  } catch (error) {
    console.error("[VENDOR_RESET_PW] error:", error);
    return res.status(500).json({ success: false, message: "Failed to reset password", error: error.message });
  }
};

// ── Vendor: own profile ────────────────────────────────────────────────────
exports.getMyVendorProfile = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const profile = await VendorProfile.findOne({ userId }).lean();
    if (!profile) return res.status(404).json({ success: false, message: "Vendor profile not found" });
    return res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("[VENDOR_ME] error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch profile", error: error.message });
  }
};

exports.updateMyVendorProfile = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const profile = await VendorProfile.findOne({ userId });
    if (!profile) return res.status(404).json({ success: false, message: "Vendor profile not found" });
    assign(profile, req.body, VENDOR_SELF_FIELDS); // cannot change email/status/commission/permissions
    await profile.save();
    return res.status(200).json({ success: true, message: "Profile updated", data: profile });
  } catch (error) {
    console.error("[VENDOR_ME_UPDATE] error:", error);
    return res.status(500).json({ success: false, message: "Failed to update profile", error: error.message });
  }
};
