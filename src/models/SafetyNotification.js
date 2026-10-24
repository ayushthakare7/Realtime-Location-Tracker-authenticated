const mongoose = require("mongoose");

const safetyNotificationSchema = new mongoose.Schema({
  notificationKey: { type: String, required: true, unique: true, index: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "SafetyJourney", required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: ["journey_shared", "journey_arrived", "journey_overdue_checkin", "journey_overdue_alert", "journey_safe_followup", "journey_cancelled", "journey_emergency"]
  },
  title: { type: String, required: true, maxlength: 160 },
  body: { type: String, required: true, maxlength: 1000 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null, index: true },
  deliveredAt: { type: Date, default: null }
}, { timestamps: true });

safetyNotificationSchema.index({ recipientId: 1, createdAt: -1 });

module.exports = mongoose.model("SafetyNotification", safetyNotificationSchema);
