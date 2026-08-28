const ClubAdmin = require("../src/modules/org/models/ClubAdminProfile");
const User = require("../src/modules/identity/models/User");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { parsePaging, pageMeta, searchFilter } = require("../utils/paginate");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

exports.getClubAdminProfile = async (req, res) => {
  try {
    const { userId } = req.params;

    // Validate userId is a valid ObjectId
    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid userId format" });
    }

    // Fetch User info - adjust field names as per your schema
    const user = await User.findById(userId).select("clubName email mobile"); // singular clubName?
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch ClubAdmin profile - check if field name is "userId" or "user"
    const clubProfile = await ClubAdmin.findOne({ userId: userId }); // explicit key:value
    if (!clubProfile) {
      return res.status(404).json({ message: "ClubAdmin profile not found" });
    }

    res.json({
      name: user.name,  // Adjust per your schema (clubName or clubNames)
      email: user.email,
      mobile: user.mobile,
      clubProfile,
    });
  } catch (error) {
    console.error("Error fetching club profile:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// Update ClubAdminProfile
// exports.updateClubAdminProfile = async (req, res) => {
//   try {
//     const userId = req.params.userId;

//     // Destructure any user fields from the request body
//     const { name, email, mobile, ...clubAdminData } = req.body;

//     // Update the ClubAdminProfile
//     const updatedProfile = await ClubAdmin.findOneAndUpdate(
//       { userId },
//       { $set: clubAdminData },
//       { new: true, runValidators: true }
//     );

//     if (!updatedProfile) {
//       return res.status(404).json({ message: "ClubAdmin profile not found" });
//     }

//     // Update User document if fields provided
//     const updatedUser = await User.findByIdAndUpdate(
//       userId,
//       {
//         ...(name && { name }),
//         ...(email && { email }),
//         ...(mobile && { mobile }),
//       },
//       { new: true, runValidators: true }
//     );

//     res.json({
//       message: "Profile updated successfully",
//       updatedProfile,
//       updatedUser,
//     });
//   } catch (error) {
//     console.error("Error updating profile:", error);
//     res.status(500).json({ message: "Server error" });
//   }
// };

// exports.updateClubAdminProfile = async (req, res) => {
//   try {
//     const userId = req.params.userId;

//     // Destructure any user fields from the request body
//     const { name, email, mobile, ...clubAdminData } = req.body;

//     // Build update object for User
//     const userUpdateFields = {};
//     if (Object.prototype.hasOwnProperty.call(req.body, 'name')) userUpdateFields.name = name;
//     if (Object.prototype.hasOwnProperty.call(req.body, 'email')) userUpdateFields.email = email;
//     if (Object.prototype.hasOwnProperty.call(req.body, 'mobile')) userUpdateFields.mobile = mobile;

//     // Update User document first
//     const updatedUser = await User.findByIdAndUpdate(
//       userId,
//       userUpdateFields,
//       { new: true, runValidators: true }
//     );

//     if (!updatedUser) {
//       return res.status(404).json({ message: "User not found" });
//     }

//     // Update the ClubAdmin profile
//     const updatedProfile = await ClubAdmin.findOneAndUpdate(
//       { userId },
//       { $set: clubAdminData },
//       { new: true, runValidators: true }
//     );

//     if (!updatedProfile) {
//       return res.status(404).json({ message: "ClubAdmin profile not found" });
//     }

//     res.json({
//       message: "Profile updated successfully",
//       updatedProfile,
//       updatedUser,
//     });
//   } catch (error) {
//     console.error("Error updating profile:", error);
//     res.status(500).json({ message: "Server error" });
//   }
// };

exports.updateClubAdminProfile = async (req, res) => {
  try {
    const userId = req.params.userId;
    const { name, email, mobile, ...clubAdminData } = req.body;

    const userUpdateFields = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) userUpdateFields.name = name;
    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) userUpdateFields.email = email;
    if (Object.prototype.hasOwnProperty.call(req.body, 'mobile')) userUpdateFields.mobile = mobile;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      userUpdateFields,
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedProfile = await ClubAdmin.findOneAndUpdate(
      { userId },
      { $set: clubAdminData },
      { new: true, runValidators: true }
    );

    if (!updatedProfile) {
      return res.status(404).json({ message: "ClubAdmin profile not found" });
    }

    // ✅ Send merged data to match frontend expectations
    res.json({
      message: "Profile updated successfully",
      clubProfile: {
        ...updatedUser.toObject(),
        ...updatedProfile.toObject(),
      }
    });

  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "Server error" });
  }
};




// POST - Create ClubAdminProfile
exports.createClubAdminProfile = async (req, res) => {
  try {
    const {
      address,
      area,
      city,
      typeOfRegistration,
      registrationDate,
      sports,
      noOfPlayers,
      timeToOpen,
      timeToClose,
      contacts,
      clubPhotosID,
      clubVideosID,
      addressLink,
      validityDate,
      locations,
      authorizations,
      userId,
    } = req.body;

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Check if profile already exists for this user
    const existingProfile = await ClubAdmin.findOne({ userId });
    if (existingProfile) {
      return res
        .status(400)
        .json({ message: "ClubAdmin profile already exists for this user" });
    }

    const newProfile = new ClubAdmin({
      address,
      area,
      city,
      typeOfRegistration,
      registrationDate,
      sports,
      noOfPlayers,
      timeToOpen,
      timeToClose,
      contacts,
      clubPhotosID,
      clubVideosID,
      addressLink,
      validityDate,
      locations,
      authorizations,
      userId,
    });

    await newProfile.save();

    res.status(201).json({
      message: "ClubAdmin profile created successfully",
      profile: newProfile,
    });
  } catch (error) {
    console.error("Error creating club profile:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.onboardClubAdmin = async (req, res) => {
  const {
    name,
    email,
    phone,
    clubName,
    address,
    city,
    area,
    sports,
    orgType,
    agencyId, // Event OS: optionally place this club/school under an agency
  } = req.body;

  const validOrgType = ["club", "school", "organization"].includes(orgType) ? orgType : "club";

  if (!name || !email || !clubName) {
    return res.status(400).json({ message: "Required fields missing." });
  }

  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User with this email already exists." });
    }

    const generatedPassword = Math.random().toString(36).slice(-8);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(generatedPassword, salt);

    const newUser = new User({
      name,
      email,
      mobile: phone,
      password: generatedPassword,
      role: "ClubAdmin",
      clubName,
      isApproved: true,
      emailVerified: true,
      ...(agencyId && /^[0-9a-fA-F]{24}$/.test(agencyId) ? { agencyId } : {}),
    });
    await newUser.save();

    // 7-day trial. Non-fatal: a billing hiccup must not block onboarding.
    // NOTE: the clock starts NOW, at provisioning — see PRICING_MODULE_PLAN §8 D6.
    const { grantTrialSafe } = require("../services/subscriptionService");
    await grantTrialSafe({ subjectId: newUser._id, subjectType: "club" });

    const generatedClubID = `CLUB-${Math.floor(100000 + Math.random() * 900000)}`;

    const newProfile = new ClubAdmin({
      clubID: generatedClubID,
      clubName: clubName,
      orgType: validOrgType,
      address: address || "TBD",
      area: area || "TBD",
      city: city || "TBD",
      typeOfRegistration: "Private",
      registrationDate: new Date(),
      sports: sports || "Multi-sport",
      noOfPlayers: 0,
      timeToOpen: "06:00 AM",
      timeToClose: "10:00 PM",
      contacts: [{
        contactPersonName: name,
        designation: "Admin",
        contactNumber: phone
      }],
      locations: city || "TBD",
      userId: newUser._id
    });
    await newProfile.save();

    const loginLink = `${process.env.FRONTEND_URL || "https://chalokhelne.com"}/login`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Welcome to Sportszz - Club Admin Credentials",
      text: `Hello ${name},\n\nYour Club Admin account for ${clubName} has been created.\n\nEmail: ${email}\nTemporary password: ${generatedPassword}\n\nPlease sign in and change your password from your profile.\n\nLogin link: ${loginLink}\n\nBest Regards,\nSportszz Team`,
    };

    // Email is best-effort — credentials may be unconfigured, or the address may
    // be unreachable. It must never block onboarding (the password is also
    // returned below so the SuperAdmin can hand it over directly).
    try {
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) console.error("Error sending email:", error.message);
        else console.log("Email sent:", info.response);
      });
    } catch (e) {
      console.error("Error sending email:", e.message);
    }

    // Return the generated temporary password so the SuperAdmin can share it
    // with the new club admin directly (don't rely on email delivery).
    res.status(201).json({
      message: "Club Admin onboarded successfully.",
      user: newUser,
      profile: newProfile,
      tempPassword: generatedPassword,
    });

  } catch (error) {
    console.error("Error onboarding club admin:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getAllClubAdmins = async (req, res) => {
  try {
    const filter = { role: "ClubAdmin", ...searchFilter(req, ["name", "email", "clubName"]) };
    const { paged, page, limit, skip } = parsePaging(req);

    // Merge each User with its ClubAdmin profile (shared helper).
    const mergeProfiles = async (users) => {
      const clubProfiles = await ClubAdmin.find({
        userId: { $in: users.map((u) => u._id) },
      });
      return users.map((user) => {
        const profile = clubProfiles.find(
          (p) => p.userId.toString() === user._id.toString()
        );
        return {
          ...user.toObject(),
          profile: profile ? profile.toObject() : null,
        };
      });
    };

    if (!paged) {
      const users = await User.find(filter).select("-password");
      const mergedData = await mergeProfiles(users);
      return res.json(mergedData); // legacy shape (raw array)
    }

    const [users, total] = await Promise.all([
      User.find(filter).select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);
    const items = await mergeProfiles(users);
    return res.json({ items, ...pageMeta(total, page, limit) });
  } catch (error) {
    console.error("Error fetching all club admins:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteClubAdmin = async (req, res) => {
  try {
    const { userId } = req.params;

    // Remove user
    const deletedUser = await User.findByIdAndDelete(userId);
    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Remove profile
    await ClubAdmin.findOneAndDelete({ userId });

    res.json({ message: "Club Admin and profile deleted successfully" });
  } catch (error) {
    console.error("Error deleting club admin:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.bulkDeleteClubAdmins = async (req, res) => {
  try {
    const { userIds } = req.body;
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "No users provided for deletion" });
    }

    // Remove users
    await User.deleteMany({ _id: { $in: userIds } });

    // Remove profiles
    await ClubAdmin.deleteMany({ userId: { $in: userIds } });

    res.json({ message: "Selected Club Admins deleted successfully" });
  } catch (error) {
    console.error("Error bulk deleting club admins:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.toggleClubAdminStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Toggle isActive flag, defaulting it to true if undefined
    user.isActive = user.isActive === undefined ? false : !user.isActive;
    await user.save();

    res.json({ message: `Club Admin is now ${user.isActive ? 'Active' : 'Inactive'}`, isActive: user.isActive });
  } catch (error) {
    console.error("Error toggling club admin status:", error);
    res.status(500).json({ message: "Server error" });
  }
};

