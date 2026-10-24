const express = require("express");
const auth = require("../middleware/authMiddleware");
const controller = require("../controllers/safetyJourneyController");

const router = express.Router();
router.use(auth);
router.get("/notifications", controller.listNotifications);
router.patch("/notifications/:notificationId/read", controller.markNotificationRead);
router.get("/modes", controller.listTravelModes);
router.post("/", controller.createDraft);
router.post("/:id/routes", controller.getRoutes);
router.post("/:id/approve", controller.approveRoute);
router.post("/:id/events", controller.appendEvents);
router.post("/:id/sync", controller.appendEvents);
router.post("/:id/cancel", controller.cancelJourney);
router.patch("/:id/sharing", controller.setJourneySharing);
router.get("/", controller.listMine);
router.get("/:id", controller.getOne);

module.exports = router;
