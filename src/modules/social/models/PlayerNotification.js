const mongoose = require("mongoose");

const playerNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        "tournament_new",      // New tournament created
        "tournament_update",   // Tournament updated
        "booking_confirmed",   // Turf booking confirmed by manager
        "booking_rejected",    // Turf booking rejected
        "booking_completed",   // Booking completed
        "registration_accepted", // Tournament registration accepted
        "registration_rejected", // Tournament registration rejected
        "chat_message",        // New chat message (when app is background)
        "invitation_received", // Tournament invitation
        "invitation_accepted", // Someone accepted your invitation
        "history_tag",         // Tagged in a post — pending playing-history entry to approve
        "general",             // General announcement
      ],
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    // Reference data for deep linking
    data: {
      tournamentId: String,
      tournamentName: String,
      bookingId: String,
      turfName: String,
      conversationId: String,
      senderName: String,
      invitationId: String,
      historyId: String,
      postId: String,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

playerNotificationSchema.index({ userId: 1, createdAt: -1 });
playerNotificationSchema.index({ userId: 1, isRead: 1 });

module.exports = mongoose.model("PlayerNotification", playerNotificationSchema);
