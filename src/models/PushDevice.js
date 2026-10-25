const mongoose = require("mongoose");

const pushDeviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  token: { type: String, required: true, unique: true, trim: true, maxlength: 4096 },
  platform: { type: String, enum: ["android", "web"], default: "android" },
  enabled: { type: Boolean, default: true, index: true },
  lastRegisteredAt: { type: Date, default: Date.now }
}, { timestamps: true });

pushDeviceSchema.index({ userId: 1, enabled: 1 });
module.exports = mongoose.models.PushDevice || mongoose.model("PushDevice", pushDeviceSchema);
