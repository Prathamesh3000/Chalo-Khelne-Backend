/**
 * Plan administration routes. Mounted at /api/plans.
 *
 * The pricing control plane is SuperAdmin-only in its entirety, so the guard
 * is on the router rather than per-endpoint — no future route can be added
 * here and accidentally ship unauthenticated. Same posture as rbacRoutes.
 */
const express = require("express");
const router = express.Router();
const planController = require("../controllers/planController");
const { requireSuperAdmin } = require("../middleware/authMiddleware");

router.use(requireSuperAdmin);

router.get("/", planController.listPlans);
router.get("/:id", planController.getPlan);
router.post("/", planController.createPlan);
router.put("/:id", planController.updatePlan);
router.delete("/:id", planController.deletePlan);

module.exports = router;
