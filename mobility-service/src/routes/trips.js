// Thin route map: authorization, throttling and handler implementation stay modular.
const express = require("express");
const auth = require("../middleware/auth");
const mobilityRateLimit = require("../middleware/rateLimit");
const destination = require("../controllers/destinationController");
const trips = require("../controllers/tripsController");
const sharedTrips = require("../controllers/sharedTripsController");

const router = express.Router();
router.use(auth, mobilityRateLimit);

router.get("/health", destination.health);
router.get("/geocode", destination.geocode);
router.post("/trips", trips.createTrip);
router.get("/trips/active", trips.getActiveTrip);
router.get("/trips/:id", trips.getTrip);
router.patch("/trips/:id/recipients", trips.updateRecipients);
router.post("/trips/:id/arrive", trips.arriveTrip);
router.post("/trips/:id/end", trips.endTrip);
router.get("/trips/shared", sharedTrips.listSharedTrips);
router.post("/trips/shared/:id/dismiss", sharedTrips.dismissSharedTrip);
router.get("/trips/shared/:id", sharedTrips.getSharedTrip);

module.exports = router;
