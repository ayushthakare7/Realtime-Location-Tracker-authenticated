const express = require("express");
const auth = require("../middleware/authMiddleware");
const { registerPushDevice, unregisterPushDevice } = require("../services/pushNotification.service");

const router = express.Router();
router.use(auth);

router.post("/register", async (req, res) => {
  try {
    const device = await registerPushDevice({
      userId: req.user.userId,
      token: req.body?.token,
      platform: req.body?.platform
    });
    res.status(200).json({ success: true, device });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : "Could not register push notifications."
    });
  }
});

router.delete("/register", async (req, res) => {
  try {
    await unregisterPushDevice({ userId: req.user.userId, token: req.body?.token });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: "Could not unregister this device." });
  }
});

module.exports = router;
