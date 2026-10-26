const express = require("express");
const auth = require("../middleware/authMiddleware");
const controller = require("../controllers/locationDeviceController");
const router = express.Router();
router.use(auth);
router.get("/", controller.listDevices);
router.patch("/active", controller.setActiveDevice);
module.exports = router;
