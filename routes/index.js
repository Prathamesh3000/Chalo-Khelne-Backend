/**
 * Central route registry — all API mount points live here.
 * Keeps server.js / app.js focused on bootstrap, not routing.
 */

const ROUTES = [
  // path                          // file (relative to routes/)
  ["/api",                          "./authRoutes"],
  ["/api/protected",                "./protectedRoutes"],
  ["/api/update",                   "./updateRoutes"],
  ["/api/manager",                  "./managerRoute"],
  ["/api/events",                   "./eventRoutes"],
  ["/api/agency",                   "./agencyAdminRoutes"],
  ["/api/agency-events",            "./agencyEventRoutes"],
  ["/api/club-facility",            "./clubFacilityRoutes"],
  ["/api/club",                     "./clubRoutes"],
  ["/api/tournaments",              "./tournamentRoutes"],
  ["/api/players",                  "./playerRoutes"],
  ["/api/email",                    "./emailverification"],
  ["/api/turfs",                    "./turfRoutes"],
  ["/api/trainer",                  "./trainerRoutes"],
  ["/api/referee",                  "./refereeRoutes"],
  ["/api/posts",                    "./postRoutes"],
  ["/api/notifications",            "./notificationRoutes"],
  ["/api/users",                    "./favoriteRoutes"],
  ["/api",                          "./passwordReset"],
  ["/api/clubadminprofile",         "./clubAdminProfileRoutes"],
  ["/api/club-sports",              "./clubSportsRoutes"],
  ["/api/training-schedule",        "./trainingScheduleRoutes"],
  ["/api/leave-requests",           "./leaveRequestRoutes"],
  ["/api/session-requests",         "./sessionRequestRoutes"],
  ["/api/attendance",               "./attendanceRoutes"],
  ["/api/students",                 "./studentRoutes"],
  ["/api/substitutes",              "./substituteRoutes"],
  ["/api/syllabus",                 "./syllabusRoutes"],
  ["/api/progress",                 "./progressRoutes"],
  ["/api/search",                   "./search"],
  ["/api/bulk-upload",              "./bulkUpload"],
  ["/api/sports",                   "./sportRoutes"],
  ["/api/sport-rules",              "./sportRuleBookRoutes"],
  ["/api/sport-library",            "./sportLibraryRoutes"],
  ["/api/debug",                    "./debugRoutes"],
  ["/api/payments",                 "./managerPaymentRoutes"],
  ["/api/razorpay",                 "./razorpayRoutes"],
  ["/api/corporate",                "./corporateRoutes"],
  ["/api/inquiries",                "./inquiryRoutes"],
  ["/api/news",                     "./newsRoutes"],
  ["/api/donations",                "./donationRoutes"],
  ["/api/onboarding",               "./onboardingRoutes"],
  ["/api/chat",                     "./chatRoutes"],
  ["/api/expenses",                 "./expenseRoutes"],
  ["/api/club-admin/finance",       "./clubAdminFinanceRoutes"],
  ["/api/roles",                    "./rbacRoutes"],
  ["/api/billing",                  "./billingRoutes"],
  ["/api/plans",                    "./planRoutes"],
  ["/api/equipment",                "./vendorRoutes"],
  ["/api/vendors",                  "./vendorAccountRoutes"],
  ["/api/vendor-store",             "./vendorStoreRoutes"],
  ["/api/invitations",              "./invitationRoutes"],
  ["/api/coupons",                  "./couponRoutes"],
  ["/api/staff-applications",       "./staffApplicationRoutes"],
  ["/api/jobs",                     "./jobsRoutes"],
  ["/api/trainer-console",          "./trainerConsoleRoutes"],
  ["/api/player-stats",             "./playerStatsRoutes"],
  ["/api/group-chat",               "./groupChatRoutes"],
  ["/api/category-templates",       "./categoryTemplateRoutes"],
  ["/api/planner",                  "./plannerRoutes"],
  ["/api/stories",                  "./storyRoutes"],
  ["/api/follow",                   "./followRoutes"],
];

// Families Policy: mount points whose features are age-gated (social graph,
// messaging, user-generated content). An account with no known age is blocked
// here — see middleware/requireDob.js. Inert until ENFORCE_DOB_GATE=true.
//
// NOT included: /api/tournaments. It serves the public tournament list and
// other read-only browsing, so gating the whole prefix would be far too broad;
// the registration/booking endpoints there should get `requireDob` individually.
const AGE_GATED_PREFIXES = new Set([
  "/api/posts",
  "/api/chat",
  "/api/group-chat",
  "/api/stories",
  "/api/follow",
]);

function mountAll(app) {
  const { requireDob } = require("../middleware/requireDob");
  ROUTES.forEach(([prefix, modulePath]) => {
    try {
      if (AGE_GATED_PREFIXES.has(prefix)) {
        app.use(prefix, requireDob, require(modulePath));
      } else {
        app.use(prefix, require(modulePath));
      }
    } catch (err) {
      console.error(`[routes] Failed to mount ${prefix} from ${modulePath}:`, err.message);
    }
  });
}

module.exports = { mountAll, ROUTES };
