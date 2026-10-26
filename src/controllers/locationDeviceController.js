const User = require("../models/User");
const LocationDevice = require("../models/LocationDevice");

function validDeviceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value);
}

exports.listDevices = async (req, res) => {
  try {
    const [user, devices] = await Promise.all([
      User.findById(req.user.userId).select("activeLocationDeviceId").lean(),
      LocationDevice.find({ userId: req.user.userId }).sort({ lastSeen: -1 }).lean()
    ]);
    const activeDeviceId = user?.activeLocationDeviceId || "";
    res.json({
      success: true,
      activeDeviceId,
      devices: devices.map(device => ({
        deviceId: device.deviceId,
        label: device.label,
        lastSeen: device.lastSeen,
        isActive: device.deviceId === activeDeviceId
      }))
    });
  } catch {
    res.status(500).json({ success: false, message: "Could not load your devices." });
  }
};

exports.setActiveDevice = async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || "");
    if (!validDeviceId(deviceId)) return res.status(400).json({ success: false, message: "Invalid device." });
    const device = await LocationDevice.findOne({ userId: req.user.userId, deviceId }).lean();
    if (!device) return res.status(404).json({ success: false, message: "That device has not connected to Reva yet. Open Reva on it and try again." });
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $set: { activeLocationDeviceId: deviceId } },
      { new: true }
    ).select("activeLocationDeviceId sharingEnabled");
    const io = req.app.get("io");
    io?.to("user:" + req.user.userId).emit("location-source-changed", {
      activeDeviceId: user.activeLocationDeviceId,
      sharingEnabled: Boolean(user.sharingEnabled)
    });
    res.json({ success: true, activeDeviceId: user.activeLocationDeviceId, sharingEnabled: Boolean(user.sharingEnabled) });
  } catch {
    res.status(500).json({ success: false, message: "Could not switch the active location device." });
  }
};
