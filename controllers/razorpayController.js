/**
 * Razorpay payment controller (Chalo Khelne). Generic across all paid flows
 * (tournament / turf / store) — the client opens an order, pays via Razorpay
 * checkout, then posts the signature back to /verify. A booking is marked paid
 * ONLY after the signature verifies server-side (fixes the trust-based gap).
 *
 * Flow: POST /order  → { key, orderId, amount, paymentId } → client checkout
 *       POST /verify → verifies HMAC → marks record + linked entity paid
 *       POST /webhook→ backup: verified webhook also confirms payment
 */
const RazorpayPayment = require("../src/modules/commerce/models/RazorpayPayment");
const rp = require("../utils/razorpay");

const rid = () => `chk_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// Mark the linked domain entity paid once its payment verifies. Best-effort per
// purpose; never throws into the verify response. Idempotent (safe on re-verify).
async function applyPaymentToPurpose(payment) {
  try {
    if (!payment.refId) return;
    if (payment.purpose === "tournament") {
      const Booking = require("../src/modules/tournaments/models/BookingModel");
      await Booking.findByIdAndUpdate(payment.refId, { paymentStatus: "paid", status: "confirmed", paymentMethod: "online" });
    } else if (payment.purpose === "turf") {
      const TurfBooking = require("../src/modules/org/models/TurfBooking");
      await TurfBooking.findByIdAndUpdate(payment.refId, { paymentStatus: "paid", status: "confirmed" });
    } else if (payment.purpose === "subscription") {
      // refId is the Plan id; `notes` carries the billing subject recorded at
      // ORDER time. The webhook path has no auth context, so the subject
      // cannot be resolved here — it must already be on the record.
      const { activateFromPayment } = require("../services/subscriptionService");
      const notes = payment.notes || {};
      if (!notes.subjectId) {
        console.error(
          `[RZP_APPLY] subscription payment ${payment._id} has no subjectId in notes — ` +
            `cannot activate. The order was created without recording the subject.`
        );
        return;
      }
      await activateFromPayment({
        subjectId: notes.subjectId,
        subjectType: notes.subjectType || "club",
        planId: payment.refId,
        razorpayOrderId: payment.razorpayOrderId,
        razorpayPaymentId: payment.razorpayPaymentId,
        pricePaidRupees: Math.round(payment.amountPaise / 100),
      });
    } else if (payment.purpose === "store") {
      // Store order model name may vary; guard so a missing model can't break verify.
      try {
        const Order = require("../src/modules/commerce/models/Payments");
        await Order.findByIdAndUpdate(payment.refId, { paymentStatus: "paid" });
      } catch { /* store linkage wired when the store flow is attached */ }
    }
  } catch (e) {
    console.error("[RZP_APPLY]", payment.purpose, e.message);
  }
}

// POST /api/payments/razorpay/order
exports.createOrder = async (req, res) => {
  try {
    if (!rp.isConfigured()) return res.status(503).json({ success: false, message: "Payments are not configured yet." });
    const { purpose, refId, amountRupees, amountPaise, name, email, phone, notes } = req.body;
    if (!["tournament", "turf", "store", "custom"].includes(purpose)) {
      return res.status(400).json({ success: false, message: "Invalid payment purpose" });
    }
    const paise = amountPaise !== undefined ? Math.round(Number(amountPaise)) : Math.round(Number(amountRupees) * 100);
    if (!Number.isFinite(paise) || paise < 100) return res.status(400).json({ success: false, message: "Enter a valid amount (minimum ₹1)." });

    const receipt = rid();
    const payment = await RazorpayPayment.create({
      userId: req.user?.id || null, purpose, refId: refId || null, amountPaise: paise,
      receipt, name: name || "", email: email || "", phone: phone || "", notes: notes || {},
    });

    const order = await rp.createOrder({ amountPaise: paise, receipt, notes: { purpose, refId: String(refId || ""), paymentId: String(payment._id) } });
    payment.razorpayOrderId = order.id;
    await payment.save();

    return res.status(201).json({
      success: true,
      key: rp.publicKeyId(),
      paymentId: payment._id,
      order: { id: order.id, amount: order.amount, currency: order.currency, receipt },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// POST /api/payments/razorpay/verify
exports.verify = async (req, res) => {
  try {
    const { paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const payment = await RazorpayPayment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
    // Bind the callback to OUR order — a signature for a different order must not pass.
    if (!razorpay_order_id || razorpay_order_id !== payment.razorpayOrderId) {
      return res.status(400).json({ success: false, message: "Order mismatch" });
    }
    const valid = rp.verifySignature({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature });
    if (!valid) {
      payment.status = "failed"; await payment.save();
      return res.status(400).json({ success: false, message: "Payment signature verification failed" });
    }
    if (payment.status !== "paid") {
      payment.status = "paid"; payment.razorpayPaymentId = razorpay_payment_id; payment.verifiedAt = new Date();
      await payment.save();
      await applyPaymentToPurpose(payment);
    }
    return res.json({ success: true, status: "paid", paymentId: payment._id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payments/razorpay/webhook  (raw body; verified via WEBHOOK_SECRET)
exports.webhook = async (req, res) => {
  try {
    const signature = req.header("x-razorpay-signature");
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
    if (!rp.verifyWebhook(raw, signature)) return res.status(400).json({ success: false, message: "Invalid webhook signature" });

    const evt = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(raw.toString()) : req.body;
    const orderId = evt?.payload?.payment?.entity?.order_id;
    if ((evt?.event === "payment.captured" || evt?.event === "order.paid") && orderId) {
      const payment = await RazorpayPayment.findOne({ razorpayOrderId: orderId });
      if (payment && payment.status !== "paid") {
        payment.status = "paid"; payment.razorpayPaymentId = evt?.payload?.payment?.entity?.id || ""; payment.verifiedAt = new Date();
        await payment.save();
        await applyPaymentToPurpose(payment);
      }
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.applyPaymentToPurpose = applyPaymentToPurpose;
