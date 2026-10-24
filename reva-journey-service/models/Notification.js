const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true, maxlength: 240 },
  recipientId: { type: String, required: true, index: true },
  journeyId: { type: String, required: true, index: true },
  type: { type: String, enum: ["journey_shared", "journey_arrived", "journey_overdue_checkin", "journey_overdue_alert", "journey_emergency", "journey_cancelled", "journey_safe_followup"], required: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  body: { type: String, required: true, trim: true, maxlength: 800 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null }
}, { timestamps: true });

notificationSchema.index({ recipientId: 1, createdAt: -1 });
module.exports = mongoose.model("JourneyServiceNotification", notificationSchema);
