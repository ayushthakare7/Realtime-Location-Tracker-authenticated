const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/authMiddleware");
const MobilityNotification = require("../models/MobilityNotification");

const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  try {
    const items = await MobilityNotification.find({ recipientId: req.user.userId, readAt: null })
      .sort({ createdAt: -1 }).limit(10).lean();
    res.json({ success: true, notifications: items.map(item => ({
      id: String(item._id), tripId: String(item.tripId), type: item.type,
      title: item.title, body: item.body, payload: item.payload, createdAt: item.createdAt
    })) });
  } catch {
    res.status(500).json({ success: false, message: "Could not load journey notifications." });
  }
});

router.patch("/:id/read", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid notification ID." });
  try {
    const result = await MobilityNotification.updateOne(
      { _id: req.params.id, recipientId: req.user.userId, readAt: null },
      { $set: { readAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Notification not found." });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: "Could not update notification." });
  }
});

module.exports = router;
