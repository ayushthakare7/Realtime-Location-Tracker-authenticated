const mongoose = require("mongoose");
const routingUsageSchema = new mongoose.Schema({
  dayKey: { type: String, required: true },
  kind: { type: String, enum: ["directions", "geocode"], required: true },
  requests: { type: Number, default: 0 }
}, { timestamps: true });
routingUsageSchema.index({ dayKey: 1, kind: 1 }, { unique: true });
module.exports = mongoose.models.MobilityRoutingUsage || mongoose.model("MobilityRoutingUsage", routingUsageSchema, "mobilityroutingusage");
