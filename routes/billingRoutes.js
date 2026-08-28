/**
 * Billing routes. Mounted at /api/billing.
 *
 * Only the caller's OWN billing state is exposed here. Plan administration is
 * SuperAdmin-only and lives in its own router (Phase 4); purchase lives on the
 * Razorpay router (Phase 5).
 */
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/billingController");
const { allowUserOrManager, authenticate } = require("../middleware/authMiddleware");

// allowUserOrManager (not `authenticate`) because a Manager must be able to
// read this too — they inherit their club's plan and the UI needs to know
// what to show them.
router.get("/me", allowUserOrManager, ctrl.getMyBilling);

// The plans this caller may buy, and the order that buys one. Purchase is
// restricted to `authenticate` (a User) rather than allowUserOrManager: a
// Manager inherits their club's plan but must not be able to spend the club's
// money.
router.get("/plans", allowUserOrManager, ctrl.listAvailablePlans);
router.post("/subscribe", authenticate, ctrl.createSubscriptionOrder);

module.exports = router;
