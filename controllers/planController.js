/**
 * Plan administration — the SuperAdmin control plane for pricing.
 *
 * SuperAdmin composes a Plan the same way they compose a Role: by ticking keys
 * from the EXISTING Permission catalogue. That reuse is the point — a plan can
 * only promise something the code actually gates, because every key already has
 * a requirePermission call site behind it.
 *
 * The whole router is SuperAdmin-only (see routes/planRoutes.js).
 */
// Model access lives in the service layer. The `legacy-controller-direct-model`
// boundary rule (.dependency-cruiser.js) fails CI on any NEW controller->model
// import, and this module has no reason to add to that tracked debt.
const planService = require("../services/planService");
const { unknownPermissionKeys } = planService;

const planController = {
  // ═══════════════════════════════════════════
  // READ
  // ═══════════════════════════════════════════

  // GET /api/plans — every plan, including retired ones. SuperAdmin view.
  listPlans: async (req, res) => {
    try {
      const { audience, active } = req.query;
      const filter = {};
      if (audience) filter.audience = audience;
      if (active !== undefined) filter.active = active === "true";

      const plans = await planService.findAll(filter);

      // Subscriber counts, so retiring or editing a plan is an informed act
      // rather than a guess. One grouped query, not one per plan.
      const byPlan = await planService.activeSubscriberCounts();

      res.json({
        success: true,
        total: plans.length,
        plans: plans.map((p) => ({
          ...p.toObject(),
          activeSubscribers: byPlan.get(String(p._id)) || 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // GET /api/plans/:id
  getPlan: async (req, res) => {
    try {
      const plan = await planService.findById(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

      const activeSubscribers = await planService.countSubscribers(plan._id);

      res.json({ success: true, plan: { ...plan.toObject(), activeSubscribers } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ═══════════════════════════════════════════
  // WRITE
  // ═══════════════════════════════════════════

  // POST /api/plans
  createPlan: async (req, res) => {
    try {
      const {
        name, slug, description, priceRupees, durationDays,
        trialDays, permissionKeys, audience, isActive, isPublic, sortOrder,
      } = req.body;

      if (!name || !slug || !audience) {
        return res.status(400).json({
          success: false,
          message: "name, slug and audience are required",
        });
      }
      if (priceRupees === undefined || durationDays === undefined) {
        return res.status(400).json({
          success: false,
          message: "priceRupees and durationDays are required",
        });
      }

      const exists = await planService.findBySlug(slug);
      if (exists) {
        return res.status(409).json({
          success: false,
          message: `Plan '${slug}' already exists`,
        });
      }

      const unknown = await unknownPermissionKeys(permissionKeys);
      if (unknown.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Unknown permission key(s): ${unknown.join(", ")}. A plan can only grant permissions that exist in the catalogue.`,
          unknownKeys: unknown,
        });
      }

      const plan = await planService.create({
        name,
        slug: String(slug).toLowerCase(),
        description: description || "",
        priceRupees,
        durationDays,
        trialDays: trialDays || 0,
        permissionKeys: permissionKeys || [],
        audience,
        isActive: isActive !== undefined ? isActive : true,
        isPublic: isPublic !== undefined ? isPublic : true,
        sortOrder: sortOrder || 0,
      });

      res.status(201).json({ success: true, plan });
    } catch (err) {
      // strict:"throw" surfaces an unknown field here as a 400, not a 500 —
      // it's the caller's payload that's wrong.
      const isStrict = /Field .* is not in schema/i.test(err.message || "");
      res.status(isStrict || err.name === "ValidationError" ? 400 : 500)
        .json({ success: false, message: err.message });
    }
  },

  // PUT /api/plans/:id
  //
  // Editing a plan does NOT change what existing subscribers hold — their
  // permissions were snapshotted onto the Subscription at purchase. The edit
  // applies to new purchases and renewals. The response says so explicitly, so
  // the UI can tell the operator what their change did and did not do.
  updatePlan: async (req, res) => {
    try {
      const plan = await planService.findById(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

      const {
        name, description, priceRupees, durationDays,
        trialDays, permissionKeys, audience, isActive, isPublic, sortOrder,
      } = req.body;

      if (permissionKeys !== undefined) {
        const unknown = await unknownPermissionKeys(permissionKeys);
        if (unknown.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Unknown permission key(s): ${unknown.join(", ")}`,
            unknownKeys: unknown,
          });
        }
        plan.permissionKeys = permissionKeys;
      }

      // slug is deliberately immutable — Subscription rows denormalise it for
      // reporting, and renaming would orphan that history.
      if (name !== undefined) plan.name = name;
      if (description !== undefined) plan.description = description;
      if (priceRupees !== undefined) plan.priceRupees = priceRupees;
      if (durationDays !== undefined) plan.durationDays = durationDays;
      if (trialDays !== undefined) plan.trialDays = trialDays;
      if (audience !== undefined) plan.audience = audience;
      if (isActive !== undefined) plan.isActive = isActive;
      if (isPublic !== undefined) plan.isPublic = isPublic;
      if (sortOrder !== undefined) plan.sortOrder = sortOrder;

      await plan.save();

      const activeSubscribers = await planService.countSubscribers(plan._id);

      res.json({
        success: true,
        plan,
        activeSubscribers,
        note:
          activeSubscribers > 0
            ? `${activeSubscribers} live subscription(s) keep the permissions they bought. This edit applies to new purchases and renewals.`
            : undefined,
      });
    } catch (err) {
      res.status(err.name === "ValidationError" ? 400 : 500)
        .json({ success: false, message: err.message });
    }
  },

  // DELETE /api/plans/:id
  //
  // Refuses while anyone is subscribed. Deleting a plan out from under live
  // subscribers would orphan their planId and destroy the record of what was
  // sold — retiring it (isActive:false) achieves the real intent, which is
  // "stop selling this", without touching anyone who already bought.
  deletePlan: async (req, res) => {
    try {
      const plan = await planService.findById(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

      const subscribers = await planService.countSubscribers(plan._id, { liveOnly: false });
      if (subscribers > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete: ${subscribers} subscription(s) reference this plan. Set isActive:false to retire it instead — existing subscribers keep what they bought and nobody new can purchase it.`,
          subscribers,
        });
      }

      await planService.remove(plan);
      res.json({ success: true, message: `Plan '${plan.slug}' deleted` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
};

module.exports = planController;
