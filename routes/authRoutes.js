const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../src/modules/identity/models/User");
const { Manager } = require("../src/modules/identity/models/ClubManager");
const DeviceToken = require("../src/modules/identity/models/DeviceToken");
const Superadminmodel = require("../src/modules/identity/models/Superadminmodel");
const Substitute = require("../src/modules/identity/models/Substitute");
const nodemailer = require("nodemailer");
require("dotenv").config();

// Welcome-email transporter — reuses the same EMAIL_USER/EMAIL_PASS env vars as
// the OTP and password-reset flows. Failures are fire-and-forget; they don't
// block registration.
const welcomeTransporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
const router = express.Router();
const path = require("path");
const fs = require("fs");
const {
  uploadMiddleware,
  cleanupFile,
  uploadsDir,
  identityDocsDir,
  certificatesDir,
} = require("../middleware/uploads");
const mongoose = require("mongoose");
const { authenticate } = require("../middleware/authMiddleware");
const { requireSelf, forceSelfBody } = require("../middleware/authz");
const { signAccessToken, signAccessTokenFor, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } = require("../utils/tokens");

// ── Rate limiting ──
// Limiters moved to middleware/rateLimiters.js so the OTP and password-reset
// routes use the same definitions instead of going unlimited (§3.2).
const { authLimiter, registerLimiter } = require("../middleware/rateLimiters");

// Register a new user
router.post("/register", registerLimiter, async (req, res) => {
  const {
    name,
    email,
    mobile,
    password,
    role: rawRole,
    age,
    dateOfBirth,
    website,
    members,
    clubName,
  } = req.body;

  // Block privilege escalation via self-registration: only these roles may be
  // self-assigned. Anything else (Manager, corporate_admin, superadmin, admin…)
  // is coerced to Player. ClubAdmin/Organization stay approval-gated (isApproved:false below).
  const SELF_REGISTER_ROLES = ["Player", "Trainer", "Referee", "ClubAdmin", "Organization"];
  const role = SELF_REGISTER_ROLES.includes(rawRole) ? rawRole : "Player";

  // Families Policy: under-13 users cannot self-register. They must be created
  // and supervised by a parent/guardian account (parent-managed). Enforced here
  // server-side so the rule holds regardless of the client.
  const computeAge = (dob) => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const t = new Date();
    let a = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
    return a;
  };
  // DOB is MANDATORY for self-registration into an age-gated role. This used to
  // be enforced only by the Mongoose `required` validator, which (a) surfaced as
  // an opaque ValidationError and (b) had to be relaxed for OAuth accounts, where
  // no DOB can exist at row-creation time. Enforcing it here keeps email/password
  // signup strict and independent of that exemption.
  if (User.AGE_GATED_ROLES.includes(role) && !dateOfBirth) {
    return res.status(400).json({
      code: "DOB_REQUIRED",
      message: "Date of birth is required to create this account.",
    });
  }

  const selfSignupAge = computeAge(dateOfBirth);
  if (dateOfBirth && selfSignupAge == null) {
    return res.status(400).json({
      code: "DOB_INVALID",
      message: "Date of birth is not a valid date.",
    });
  }
  if (selfSignupAge != null && selfSignupAge < 13) {
    return res.status(400).json({
      code: "UNDER_13_SELF_SIGNUP",
      message:
        "Players under 13 can't create their own account. Ask a parent or guardian to create and manage it.",
    });
  }

  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }

    // For ClubAdmin role - check if club name already exists
    if (role === "ClubAdmin" && clubName) {
      const existingClub = await User.findOne({
        role: "ClubAdmin",
        clubName: clubName.trim(),
      });
      if (existingClub) {
        return res.status(400).json({ message: "Club name already exists" });
      }
    }

    user = new User({
      name,
      email,
      mobile,
      password,
      role,
      age,
      dateOfBirth,
      website,
      members,
      clubName: role === "ClubAdmin" ? clubName?.trim() : undefined,
      isApproved:
        role === "ClubAdmin" || role === "Organization" ? false : true,
    });

    await user.save();

    // For ClubAdmin, set clubId to their own _id (self-reference)
    if (role === "ClubAdmin") {
      user.clubId = user._id;
      await user.save();

      // 7-day trial. Non-fatal — a billing hiccup must not block registration.
      const { grantTrialSafe } = require("../services/subscriptionService");
      await grantTrialSafe({ subjectId: user._id, subjectType: "club" });
    }

    // Fire-and-forget welcome email — failures don't block registration.
    const welcomeText = user.isApproved
      ? `Hello ${user.name},\n\nWelcome to Sportszz! Your account is ready and you can sign in any time.\n\nIf you didn't create this account, please ignore this email.\n\n— The Sportszz Team`
      : `Hello ${user.name},\n\nWelcome to Sportszz! Your account has been created and is pending admin approval. You'll be notified once it's active.\n\nIf you didn't create this account, please ignore this email.\n\n— The Sportszz Team`;
    welcomeTransporter
      .sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: "Welcome to Sportszz",
        text: welcomeText,
      })
      .catch((e) => console.error("[REGISTER] welcome email failed:", e.message));

    if (user.isApproved) {
      const payload = { userId: user.id };
      jwt.sign(
        payload,
        process.env.JWT_SECRET,
        { expiresIn: "30d" },
        (err, token) => {
          if (err) throw err;
          res.json({ token, message: "Registration successful" });
        }
      );
    } else {
      res.json({ message: "Registration successful, waiting for approval" });
    }
  } catch (error) {
    console.error("[REGISTER] failed:", error);
    // Duplicate unique index (e.g. email) → clean 400 instead of a 500.
    if (error && error.code === 11000) {
      const field = Object.keys(error.keyPattern || error.keyValue || {})[0] || "field";
      return res.status(400).json({
        message:
          field === "email"
            ? "An account with this email already exists."
            : `An account with this ${field} already exists.`,
        code: "DUPLICATE_KEY",
        field,
      });
    }
    // Mongoose validation (e.g. missing mobile/name) → 400 with the failing field.
    if (error && error.name === "ValidationError") {
      const first = Object.values(error.errors || {})[0];
      return res.status(400).json({
        message: first ? first.message : "Please fill in all required fields.",
        code: "VALIDATION_ERROR",
      });
    }
    // ALWAYS return JSON — the mobile/web clients call res.json() on the body.
    // (Previously this sent the plain text "Server error", which crashed the
    // client with: JSON Parse error: Unexpected character: S.)
    res.status(500).json({
      message: "Registration failed. Please try again.",
      error: error.message,
    });
  }
});

// Login as User or Manager
router.post("/login", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = (req.body.password || "").trim();

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    // Case-insensitive email lookup using MongoDB collation (safe, no regex needed)
    const emailQuery = { email };
    const collation = { locale: "en", strength: 2 }; // strength 2 = case-insensitive
    const user = await User.findOne(emailQuery).collation(collation);
    const superadmin = await Superadminmodel.findOne(emailQuery).collation(collation);
    const manager = await Manager.findOne(emailQuery).collation(collation);
    const substitute = await Substitute.findOne({ ...emailQuery, status: "accepted" }).collation(collation);

    // 🛑 Conflict Check
    const foundRoles = [user, superadmin, manager, substitute].filter(Boolean);
    if (foundRoles.length > 1) {
      return res.status(409).json({
        message:
          "Email exists for multiple roles. Please contact support or use a different account.",
      });
    }

    // ✅ Superadmin Login
    if (superadmin) {
      const match = await bcrypt.compare(password, superadmin.password);
      if (!match) return res.status(401).json({ message: "Invalid credentials" });

      const token = jwt.sign(
        { email, role: "superadmin", userId: superadmin._id },
        process.env.JWT_SECRET,
        { expiresIn: "30d" } // access lifetime unchanged (Phase 9: shorten once web panel adds refresh-on-401)
      );
      const refreshToken = await issueRefreshToken(superadmin._id, {
        principalType: "Superadmin",
        singleSession: true,
        userAgent: req.headers["user-agent"],
      });
      return res.json({
        token,
        refreshToken,
        user: {
          id: superadmin._id,
          _id: superadmin._id,
          email: superadmin.email,
          name: superadmin.name || "Super Admin",
          role: "superadmin",
        },
      });
    }

    // ✅ Manager Login
    if (manager) {
      const isPasswordValid = await bcrypt.compare(password, manager.password);
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      // SA-controlled suspension/rejection — runs AFTER password verify so a
      // wrong-password attempt still gets a generic "Invalid credentials" and
      // can't be used to probe whether an account is suspended.
      if (manager.status === "suspended") {
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_SUSPENDED",
          message: "Your account has been suspended. Contact support.",
          reason: manager.suspensionReason || null,
        });
      }
      if (manager.status === "rejected") {
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_REJECTED",
          message: "Your account has been rejected. Contact support.",
          reason: manager.suspensionReason || null,
        });
      }

      if (!manager.isActive) {
        return res.status(403).json({ message: "Manager is not active" });
      }

      const token = jwt.sign(
        { id: manager._id, role: "Manager" },
        process.env.JWT_SECRET,
        { expiresIn: "30d" } // access lifetime unchanged (Phase 9: shorten once web panel adds refresh-on-401)
      );
      const refreshToken = await issueRefreshToken(manager._id, {
        principalType: "Manager",
        singleSession: true,
        userAgent: req.headers["user-agent"],
      });

      // Check if the parent club is a corporate admin
      const parentUser = await User.findById(manager.clubId);
      const isCorporate = parentUser && parentUser.role === "corporate_admin";

      return res.json({
        token,
        refreshToken,
        user: {
          id: manager._id,
          email: manager.email,
          name: manager.name,
          role: "Manager",
          staffRole: manager.staffRole || "manager",
          clubId: manager.clubId || null,
          isCorporate: !!isCorporate,
        },
      });
    }

    // ✅ Substitute Login (temporary stand-in for a coach)
    if (substitute) {
      if (!substitute.active) {
        return res.status(403).json({ message: "Your substitute access has ended." });
      }
      const isPasswordValid = await bcrypt.compare(password, substitute.password || "");
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      const token = jwt.sign(
        { id: substitute._id, role: "Substitute" },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );
      return res.json({
        token,
        user: {
          id: substitute._id,
          email: substitute.email,
          name: substitute.name,
          role: "Substitute",
          coachId: substitute.coachId || null,
          coachName: substitute.coachName || "",
          clubId: substitute.clubId || null,
        },
      });
    }

    // ✅ User/Admin Login
    if (user) {
      if (!user.isApproved) {
        return res.status(403).json({ message: "User not approved yet" });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ message: "Invalid credentials" });

      // SA-controlled suspension/rejection — runs AFTER password verify.
      if (user.status === "suspended") {
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_SUSPENDED",
          message: "Your account has been suspended. Contact support.",
          reason: user.suspensionReason || null,
        });
      }
      if (user.status === "rejected") {
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_REJECTED",
          message: "Your account has been rejected. Contact support.",
          reason: user.suspensionReason || null,
        });
      }

      const token = signAccessToken(user);
      const refreshToken = await issueRefreshToken(user._id, { userAgent: req.headers["user-agent"] });
      return res.json({
        token,
        refreshToken,
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          clubName: user.clubName,
          clubId: user.clubId,
        },
      });
    }

    return res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ message: "Error logging in", error });
  }
});

const otpStore = {};

// Forgot password reset (unified endpoint)
router.post("/forgot-password/reset", authLimiter, async (req, res) => {
  try {
    console.log("Received request body:", req.body); // Debug log

    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (
      !otpStore[email] ||
      otpStore[email].otp !== parseInt(otp) ||
      otpStore[email].expiresAt < Date.now()
    ) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });
    delete otpStore[email];

    res.json({ message: "Password reset successful!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Legacy auth endpoint for backward compatibility
router.post("/forgot-password/reset/auth", authLimiter, async (req, res) => {
  try {
    console.log("Received request body:", req.body); // Debug log

    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (
      !otpStore[email] ||
      otpStore[email].otp !== parseInt(otp) ||
      otpStore[email].expiresAt < Date.now()
    ) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });
    delete otpStore[email];

    res.json({ message: "Password reset successful!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Superadmin login
router.post("/superadminlogin", authLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await Superadminmodel.findOne({ email });
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      const token = jwt.sign({ email, userId: user._id }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
      const refreshToken = await issueRefreshToken(user._id, {
        principalType: "Superadmin",
        singleSession: true,
        userAgent: req.headers["user-agent"],
      });
      return res.json({
        success: true,
        token,
        refreshToken,
        user: {
          id: user._id,
          _id: user._id,
          email: user.email,
          name: user.name || "Super Admin",
          role: "superadmin",
        },
      });
    } else {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Google Sign-In endpoint
router.post("/google-login", authLimiter, async (req, res) => {
  const { token, email, name, platform } = req.body;

  try {
    if (!token || !email) {
      return res.status(400).json({ message: "Token and email are required" });
    }

    let googleUserInfo;

    // The mobile app sends an idToken from @react-native-google-signin
    // Verify it using Google's tokeninfo endpoint
    const { OAuth2Client } = require("google-auth-library");
    if (!process.env.GOOGLE_WEB_CLIENT_ID) {
      console.error("[GOOGLE] GOOGLE_WEB_CLIENT_ID is not set in the server environment");
    }
    const client = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);

    try {
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_WEB_CLIENT_ID,
      });
      googleUserInfo = ticket.getPayload();
    } catch (idTokenError) {
      // Diagnostic: surface exactly why idToken verification failed (audience
      // mismatch, expired token, wrong client id, etc.) — see bug #28.
      console.warn("[GOOGLE] idToken verify failed:", idTokenError?.message);
      // Fallback: try as access token (for web/legacy clients)
      try {
        const userInfoResponse = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!userInfoResponse.ok) {
          console.warn("[GOOGLE] userinfo fallback failed:", userInfoResponse.status);
          return res.status(401).json({ message: "Token verification failed. Please try again." });
        }

        googleUserInfo = await userInfoResponse.json();
      } catch (fallbackError) {
        console.warn("[GOOGLE] userinfo fallback threw:", fallbackError?.message);
        return res.status(401).json({ message: "Token verification failed. Please try again." });
      }
    }

    // Verify email is verified with Google
    if (!googleUserInfo.email_verified) {
      return res.status(400).json({
        message: "Please verify your email with Google first",
      });
    }

    // Verify email matches
    if (googleUserInfo.email !== email) {
      return res.status(400).json({ message: "Authentication failed" });
    }

    // Find or create user
    let user = await User.findOne({
      $or: [{ email: googleUserInfo.email }, { googleId: googleUserInfo.sub }],
    });

    if (!user) {
      const randomPassword =
        Math.random().toString(36) + Date.now().toString(36);

      user = new User({
        name: name || googleUserInfo.name,
        email: googleUserInfo.email,
        password: await bcrypt.hash(randomPassword, 10),
        isApproved: true,
        role: "Player",
        authProvider: "google",
        googleId: googleUserInfo.sub,
        emailVerified: true,
        profilePicture: googleUserInfo.picture || null,
        mobile: "pending",
        needsMobileUpdate: true,
        // Google does not return a birthday, so the account is created locked:
        // every age-gated route rejects it until the app's DOB screen posts one.
        dobRequired: true,
      });

      try {
        await user.save();
      } catch (saveError) {
        // Previously swallowed — a schema change here surfaced as a bare 500
        // with no stack, which made the DOB regression very hard to trace.
        console.error("[GOOGLE] account creation failed:", saveError?.message, saveError?.errors ? Object.keys(saveError.errors) : "");
        return res.status(500).json({
          message: "Failed to create account",
          requiresMobile: true,
        });
      }
    } else {
      // Update existing user's Google info if needed
      if (!user.googleId || user.googleId !== googleUserInfo.sub) {
        user.googleId = googleUserInfo.sub;
        user.authProvider = "google";
        if (googleUserInfo.picture && !user.profilePicture) {
          user.profilePicture = googleUserInfo.picture;
        }
        // Legacy accounts created before DOB was mandatory would otherwise fail
        // validation on this save and surface as a misleading 401. Flag them
        // instead so they hit the DOB screen like any other incomplete account.
        if (!user.dateOfBirth && User.AGE_GATED_ROLES.includes(user.role)) {
          user.dobRequired = true;
        }
        await user.save();
      }
    }

    // SA-controlled suspension/rejection — even via Google auth.
    if (user.status === "suspended") {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "Your account has been suspended. Contact support.",
        reason: user.suspensionReason || null,
      });
    }
    if (user.status === "rejected") {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_REJECTED",
        message: "Your account has been rejected. Contact support.",
        reason: user.suspensionReason || null,
      });
    }

    // Short-lived access token + rotating refresh token (Phase 8.1).
    const jwtToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user._id, { userAgent: req.headers["user-agent"] });

    res.json({
      token: jwtToken,
      refreshToken,
      user: {
        id: user._id,
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isApproved: user.isApproved,
        profilePicture: user.profilePicture,
        mobile: user.mobile,
        needsMobileUpdate: user.needsMobileUpdate || user.mobile === "pending",
        // The app MUST present a blocking, non-dismissible DOB screen when this
        // is true — the account is locked out of every age-gated route until a
        // DOB is posted (Families Policy neutral age screen).
        requiresDob: user.dobRequired === true || (!user.dateOfBirth && User.AGE_GATED_ROLES.includes(user.role)),
      },
    });
  } catch (error) {
    console.error("Google login error:", error.message);
    res.status(401).json({
      message: "Authentication failed. Please try again.",
    });
  }
});

// Update user profile
router.put("/user/profile/:id", authenticate, requireSelf("id"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Fields that need to be updated
    const updateableFields = [
      "name",
      "dateOfBirth",
      "age",
      "sex",
      "sports",
      "clubNames",
      "clubName",
      "mobile",
      "emergencyContact",
      "email",
      "address",
      "rank",
      "achievements",
      "identityType",
      "identityId",
      "locations",
      "referralCode",
      "bio",
      "certificates",
    ];

    // Create update object with only the fields that exist in the request
    const updateData = {};
    updateableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        // Special handling for arrays (like certificates, sports, clubNames)
        if (Array.isArray(req.body[field])) {
          updateData[field] = req.body[field];
        }
        // Handle empty strings
        else if (req.body[field] === "") {
          updateData[field] = "";
        }
        // Handle other values
        else if (req.body[field] !== user[field]) {
          updateData[field] = req.body[field];
        }
      }
    });

    // If there are changes, update the user
    if (Object.keys(updateData).length > 0) {
      const updatedUser = await User.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true }
      );

      res.json({
        message: "Profile updated successfully",
        user: updatedUser,
      });
    } else {
      res.json({
        message: "No changes to update",
        user: user,
      });
    }
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get user profile — returns PII (DOB, mobile, address, identityId, certs),
// so requireSelf: a user may only fetch their own profile. Cross-user reads
// (manager viewing a player for approval, etc.) should use a separate
// safe-subset endpoint, not this one.
router.get("/user/profile/:id", authenticate, requireSelf("id"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Format the response according to your existing schema
    const profileData = {
      playerId: user.playerId,
      name: user.name,
      dateOfBirth: user.dateOfBirth,
      age: user.age,
      sex: user.sex,
      sports: user.sports.length ? user.sports : ["table-tennis"], // Set default if empty
      clubNames: user.clubNames,
      mobile: user.mobile,
      emergencyContact: user.emergencyContact,
      email: user.email,
      address: user.address,
      rank: user.rank,
      achievements: user.achievements,
      identityType: user.identityType,
      identityId: user.identityId,
      locations: user.locations,
      referralCode: user.referralCode,
      profileImage: user.profileImage,
      certificates: user.certificates,
      bio: user.bio,
    };

    res.json(profileData);
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Profile image upload route
router.post(
  "/user/profile/upload-image/:id",
  authenticate,
  requireSelf("id"),
  uploadMiddleware.single("profile-image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const user = await User.findById(req.params.id);
      if (!user) {
        await cleanupFile(req.file.path);
        return res.status(404).json({ message: "User not found" });
      }

      // Delete old profile image if exists
      if (user.profileImage) {
        const oldImagePath = path.join(uploadsDir, user.profileImage);
        await cleanupFile(oldImagePath);
      }

      const relativePath = path
        .join("profiles", path.basename(req.file.path))
        .replace(/\\/g, "/");

      user.profileImage = relativePath;
      await user.save();

      res.json({
        message: "Profile image uploaded successfully",
        imageUrl: relativePath,
      });
    } catch (error) {
      if (req.file) await cleanupFile(req.file.path);
      res.status(500).json({ message: error.message });
    }
  }
);

// Cover / banner image upload route
router.post(
  "/user/profile/upload-cover/:id",
  authenticate,
  requireSelf("id"),
  uploadMiddleware.single("cover-image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const user = await User.findById(req.params.id);
      if (!user) {
        await cleanupFile(req.file.path);
        return res.status(404).json({ message: "User not found" });
      }

      // Delete old cover image if exists
      if (user.coverImage) {
        const oldImagePath = path.join(uploadsDir, user.coverImage);
        await cleanupFile(oldImagePath);
      }

      const relativePath = path
        .join("profiles", path.basename(req.file.path))
        .replace(/\\/g, "/");

      user.coverImage = relativePath;
      await user.save();

      res.json({
        message: "Cover image uploaded successfully",
        imageUrl: relativePath,
      });
    } catch (error) {
      if (req.file) await cleanupFile(req.file.path);
      res.status(500).json({ message: error.message });
    }
  }
);

// Error handling middleware
// multer is referenced below for MulterError; without this require the handler
// throws ReferenceError and turns a clean 400 into a 500.
const multer = require("multer");
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        message: "File size cannot exceed 15MB",
      });
    }
    return res.status(400).json({
      message: "File upload error: " + err.message,
    });
  }

  res.status(500).json({
    message: err.message || "An unknown error occurred",
  });
});

// Certificate upload route
// router.post(
//   "/user/profile/upload-certificate/:id",
//   uploadMiddleware.single("certificate"),
//   async (req, res) => {
//     try {
//       if (!req.file) {
//         return res.status(400).json({ message: "No file uploaded" });
//       }

//       const user = await User.findById(req.params.id);
//       if (!user) {
//         await cleanupFile(req.file.path);
//         return res.status(404).json({ message: "User not found" });
//       }

//       const relativePath = path
//         .join("certificates", path.basename(req.file.path))
//         .replace(/\\/g, "/");

//       const certificateInfo = {
//         path: relativePath,
//         name: req.file.originalname,
//         type: req.file.mimetype,
//         uploadedAt: new Date(),
//       };

//       if (!user.certificates) {
//         user.certificates = [];
//       }

//       user.certificates.push(certificateInfo);
//       await user.save();

//       res.json({
//         message: "Certificate uploaded successfully",
//         certificate: certificateInfo,
//       });
//     } catch (error) {
//       if (req.file) await cleanupFile(req.file.path);
//       res.status(500).json({ message: error.message });
//     }
//   }
// );

// Certificate deletion route
router.delete(
  "/user/profile/certificate/:id/:certificateIndex",
  authenticate,
  requireSelf("id"),
  async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const certificateIndex = parseInt(req.params.certificateIndex);
      if (
        certificateIndex < 0 ||
        certificateIndex >= user.certificates.length
      ) {
        return res.status(400).json({ message: "Invalid certificate index" });
      }

      // Get certificate before removing
      const certificate = user.certificates[certificateIndex];

      // Remove certificate from array
      user.certificates.splice(certificateIndex, 1);
      await user.save();

      // Delete file from storage
      if (certificate && certificate.path) {
        const fullPath = path.join(
          __dirname,
          "..",
          "uploads",
          certificate.path
        );
        await cleanupFile(fullPath);
      }

      res.json({ message: "Certificate deleted successfully" });
    } catch (error) {
      console.error("Certificate deletion error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Certificate retrieval route — authenticated only (filenames are multer-random
// so guessing is hard, but never serve PII certs over a public URL).
router.get("/certificates/:filename", authenticate, async (req, res) => {
  try {
    // basename() collapses traversal: an encoded "../../.env" reaches us as a
    // decoded path and would otherwise escape certificatesDir via path.join.
    const filename = path.basename(req.params.filename);

    // "Authenticated" was not enough — any logged-in user could read any
    // professional's certificate. Same owner-or-reviewer rule as the
    // /uploads/certificates handler, from the one shared authorizer.
    const { AUTHORIZERS } = require("../middleware/serveUploads");
    const allowed = await AUTHORIZERS.certificates(
      req,
      `uploads/certificates/${filename}`
    );
    if (!allowed) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const filepath = path.join(certificatesDir, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType =
      {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
      }[ext] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("Certificate retrieval error:", error);
    res.status(500).json({ message: "Error retrieving certificate" });
  }
});

// Identity document upload route
// router.post(
//   "/user/identity/:id",
//   uploadMiddleware.single("identity-document"),
//   async (req, res) => {
//     try {
//       if (!req.file) {
//         return res.status(400).json({ message: "No file uploaded" });
//       }

//       const user = await User.findById(req.params.id);
//       if (!user) {
//         await cleanupFile(req.file.path);
//         return res.status(404).json({ message: "User not found" });
//       }

//       // Delete old identity document if exists
//       if (user.identityDocument && user.identityDocument.path) {
//         try {
//           const oldPath = path.join(uploadsDir, user.identityDocument.path);
//           await fs.promises.unlink(oldPath);
//         } catch (err) {
//           console.error("Error deleting old file:", err);
//           // Continue even if old file deletion fails
//         }
//       }

//       // Validate identity type and number
//       const { identityType, identityNumber } = req.body;
//       console.log("Received identity data:", { identityType, identityNumber }); // Debug log

//       const AADHAR_PATTERN = /^\d{12}$/;
//       const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

//       if (
//         identityType === "aadhar-card" &&
//         !AADHAR_PATTERN.test(identityNumber)
//       ) {
//         await cleanupFile(req.file.path);
//         return res
//           .status(400)
//           .json({ message: "Invalid Aadhar number format" });
//       }

//       if (
//         identityType === "pan-card" &&
//         !PAN_PATTERN.test(identityNumber.toUpperCase())
//       ) {
//         await cleanupFile(req.file.path);
//         return res.status(400).json({ message: "Invalid PAN number format" });
//       }

//       // Create relative path for the new file
//       const identityDocsPath = path.relative(uploadsDir, identityDocsDir);
//       const fileName = path.basename(req.file.path);
//       const relativePath = path
//         .join(identityDocsPath, fileName)
//         .replace(/\\/g, "/");

//       // Update user document
//       user.identityDocument = {
//         path: relativePath,
//         name: req.file.originalname,
//         type: req.file.mimetype,
//         uploadedAt: new Date(),
//       };

//       // Also update the identity type and number
//       user.identityType = identityType;
//       user.identityId =
//         identityType === "pan-card"
//           ? identityNumber.toUpperCase()
//           : identityNumber;

//       await user.save();

//       res.json({
//         message: "Identity document uploaded successfully",
//         document: user.identityDocument,
//       });
//     } catch (error) {
//       if (req.file) {
//         await cleanupFile(req.file.path);
//       }
//       console.error("Identity document upload error:", error);
//       res.status(500).json({ message: error.message });
//     }
//   }
// );

// Get identity document route
router.get("/user/identity/:id", authenticate, requireSelf("id"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user || !user.identityDocument || !user.identityDocument.path) {
      return res.status(404).json({ message: "Identity document not found" });
    }

    const filePath = path.join(uploadsDir, user.identityDocument.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Document file not found" });
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error("Identity document retrieval error:", error);
    res.status(500).json({ message: "Error retrieving identity document" });
  }
});

// Device token management endpoints

// check-token endpoint
router.post("/check-token", async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({
        success: false,
        message: "User ID and token are required",
      });
    }

    const objectId = mongoose.Types.ObjectId.createFromHexString(userId);

    // Check for an active token for this user and token combination
    const existingToken = await DeviceToken.findOne({
      userId: objectId,
      token: token,
      isActive: true,
    });

    res.json({
      exists: !!existingToken,
      isActive: existingToken?.isActive || false,
    });
  } catch (error) {
    console.error("[TOKEN_CHECK] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// register-device endpoint
router.post("/register-device", authenticate, forceSelfBody("userId"), async (req, res) => {
  try {
    console.log("[DEVICE_REGISTER] Received request:", req.body);
    const { userId, token, allowNotifications } = req.body;

    if (!userId || !token) {
      return res.status(400).json({
        success: false,
        message: "User ID and token are required",
      });
    }

    const objectId = mongoose.Types.ObjectId.createFromHexString(userId);

    // Find if this user already has any tokens
    const userExistingTokens = await DeviceToken.findOne({ userId: objectId });

    // If this token is already assigned to another user, reject it
    const tokenAssignedToOther = await DeviceToken.findOne({
      token: token,
      userId: { $ne: objectId },
    });

    if (tokenAssignedToOther) {
      return res.status(400).json({
        success: false,
        message: "Please generate a new token for this user",
        requireNewToken: true,
      });
    }

    // Deactivate any existing tokens for this user
    await DeviceToken.updateMany(
      { userId: objectId },
      {
        isActive: false,
        lastUpdated: new Date(),
      }
    );

    // Create new token for this user
    const deviceToken = new DeviceToken({
      userId: objectId,
      token,
      allowNotifications,
      isActive: true,
      lastUpdated: new Date(),
    });

    await deviceToken.save();
    console.log("[DEVICE_REGISTER] Created new token for user:", userId);

    res.json({
      success: true,
      message: "Device registered successfully",
      tokenId: deviceToken._id,
    });
  } catch (error) {
    console.error("[DEVICE_REGISTER] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to register device",
      error: error.message,
    });
  }
});

// Check device token endpoint
router.get("/check-device-token/:userId", authenticate, requireSelf("userId"), async (req, res) => {
  try {
    const userId = req.params.userId;
    const objectId = mongoose.Types.ObjectId.createFromHexString(userId);

    const existingToken = await DeviceToken.findOne({
      userId: objectId,
      isActive: true,
    });

    res.json({
      hasToken: !!existingToken,
      tokenId: existingToken?._id,
    });
  } catch (error) {
    console.error("[TOKEN_CHECK] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Deregister device endpoint
router.post("/deregister-device", authenticate, forceSelfBody("userId"), async (req, res) => {
  const { userId, token } = req.body;

  try {
    // Find and deactivate the token
    await DeviceToken.updateOne(
      { userId, token, isActive: true },
      { isActive: false, lastUpdated: new Date() }
    );

    res.status(200).send({ success: true });
  } catch (error) {
    console.error("[DEREGISTER_DEVICE] Error:", error);
    res
      .status(500)
      .send({ success: false, error: "Failed to deregister token" });
  }
});

// Get current authenticated user
router.get("/user/me", async (req, res) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Expose follower/following counts without dumping the full arrays.
    const obj = user.toObject();
    obj.followersCount = (user.followers || []).length;
    obj.followingCount = (user.following || []).length;
    delete obj.followers;
    delete obj.following;
    res.json(obj);
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(401).json({ message: "Invalid token" });
  }
});

// Check available roles for a user (based on which service profiles exist)
router.get("/user/can-switch-role/:userId", authenticate, requireSelf("userId"), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ canSwitch: false, message: "User not found" });
    }

    // Always available
    const availableRoles = ["Player"];

    // Check if trainer profile exists
    const Trainer = require("../src/modules/org/models/Trainer");
    const trainerProfile = await Trainer.findOne({ userId: user._id });
    if (trainerProfile) availableRoles.push("Trainer");

    // Check if referee profile exists
    const Referee = require("../src/modules/catalog/models/Referee");
    const refereeProfile = await Referee.findOne({ userId: user._id });
    if (refereeProfile) availableRoles.push("Referee");

    const canSwitch = availableRoles.length > 1;
    res.json({
      canSwitch,
      currentRole: user.role,
      availableRoles,
    });
  } catch (error) {
    console.error("Error checking role switch:", error);
    res.status(500).json({ canSwitch: false, message: error.message });
  }
});

// Switch user role (Player / Trainer / Referee)
router.post("/user/switch-role/:userId", async (req, res) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    if (decoded.id !== req.params.userId) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Accept target role from request body, or cycle to next
    const allowedRoles = ["Player", "Trainer", "Referee"];
    let newRole = req.body.targetRole;

    if (!newRole || !allowedRoles.includes(newRole)) {
      // Cycle: Player → Trainer → Referee → Player
      const currentIndex = allowedRoles.indexOf(user.role);
      newRole = allowedRoles[(currentIndex + 1) % allowedRoles.length];
    }

    user.role = newRole;
    await user.save();

    // New short-lived access token with the updated role (refresh token unchanged).
    const newToken = signAccessToken(user);

    res.json({
      success: true,
      message: `Switched to ${newRole} mode`,
      token: newToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: newRole,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Error switching role:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Refresh / logout (Phase 8.1) ──────────────────────────────
// Exchange a valid refresh token for a new access token, rotating the refresh
// token. No access token required (the access token is expired by design).
router.post("/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    const result = await rotateRefreshToken(refreshToken, { userAgent: req.headers["user-agent"] });
    if (result.error) {
      // invalid | reuse | expired all collapse to a generic 401 → client re-logs-in.
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }
    // Reload the principal from the correct collection for its type.
    let principal = null;
    if (result.principalType === "Manager") {
      principal = await Manager.findById(result.principalId).select("_id email name");
    } else if (result.principalType === "Superadmin") {
      principal = await Superadminmodel.findById(result.principalId).select("_id email name");
    } else {
      principal = await User.findById(result.principalId).select("_id role email name clubName clubId");
    }
    if (!principal) {
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }
    const token = signAccessTokenFor(principal, result.principalType);
    return res.json({ token, refreshToken: result.refreshToken });
  } catch (err) {
    console.error("[auth/refresh]", err.message);
    return res.status(500).json({ success: false, message: "Could not refresh session" });
  }
});

// Revoke a refresh token (real server-side logout / kill-switch). Best-effort.
router.post("/auth/logout", async (req, res) => {
  try {
    await revokeRefreshToken(req.body?.refreshToken);
  } catch (err) {
    console.error("[auth/logout]", err.message);
  }
  return res.json({ success: true });
});

module.exports = router;