const express = require("express");
const auth = require("../middleware/authMiddleware");
const controller = require("../controllers/safetyJourneyController");

const router = express.Router();
router.use(auth);
router.get("/modes", controller.listTravelModes);
router.post("/", controller.createDraft);
router.post("/:id/routes", controller.getRoutes);
router.post("/:id/approve", controller.approveRoute);
router.get("/", controller.listMine);
router.get("/:id", controller.getOne);

module.exports = router;
