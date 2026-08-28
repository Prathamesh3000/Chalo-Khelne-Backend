const mongoose = require("mongoose");

/**
 * RazorpayPayment — a real gateway payment record (Chalo Khelne). Created when a
 * checkout order is opened; flipped to "paid" ONLY after server-side signature
 * verification (razorpayController.verify) or a verified webhook. `purpose`+`refId`
 * link it to the thing being paid for (a tournament booking, turf booking, or
 * store order) so verify can mark that entity paid.
 */
const razorpayPaymentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // "subscription": refId is the Plan id, and `notes` carries the billing
// subject recorded at ORDER time — the webhook fires server-to-server with no
// auth context, so the subject cannot be resolved at activation.
    purpose: { type: String, enum: ["tournament", "turf", "store", "custom", "subscription"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true }, // booking / turfBooking / order id
    amountPaise: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "INR" },
    receipt: { type: String, default: "" },
    razorpayOrderId: { type: String, default: "", index: true },
    razorpayPaymentId: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created", index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    notes: { type: mongoose.Schema.Types.Mixed, default: {} },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RazorpayPayment", razorpayPaymentSchema);
