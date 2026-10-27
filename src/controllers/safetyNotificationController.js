// Safety Travel notification inbox endpoints.
const SafetyNotification = require("../models/SafetyNotification");
exports.listNotifications = async (req, res) => {
  try {
    const notifications = await SafetyNotification.find({ recipientId: req.user.userId })
      .sort({ createdAt: -1 }).limit(100).lean();
    return res.json({
      success: true,
      notifications: notifications.map(item => ({
        id: String(item._id), type: item.type, title: item.title, body: item.body,
        payload: item.payload, createdAt: item.createdAt, readAt: item.readAt
      }))
    });
  } catch (error) {
    console.error("Load safety notifications failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load notifications." });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    if (!/^[a-f\\d]{24}$/i.test(String(req.params.notificationId || ""))) {
      return res.status(400).json({ success: false, message: "Invalid notification ID." });
    }
    const notification = await SafetyNotification.findOneAndUpdate(
      { _id: req.params.notificationId, recipientId: req.user.userId },
      { $set: { readAt: new Date() } },
      { new: true }
    ).lean();
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found." });
    return res.json({ success: true, id: String(notification._id), readAt: notification.readAt });
  } catch (error) {
    console.error("Mark notification read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not update notification." });
  }
};
exports.markNotificationRead = async (req, res) => {
  try {
    if (!/^[a-f\\d]{24}$/i.test(String(req.params.notificationId || ""))) {
      return res.status(400).json({ success: false, message: "Invalid notification ID." });
    }
    const notification = await SafetyNotification.findOneAndUpdate(
      { _id: req.params.notificationId, recipientId: req.user.userId },
      { $set: { readAt: new Date() } },
      { new: true }
    ).lean();
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found." });
    return res.json({ success: true, id: String(notification._id), readAt: notification.readAt });
  } catch (error) {
    console.error("Mark notification read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not update notification." });
  }
};
