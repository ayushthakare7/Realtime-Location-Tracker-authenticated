const { listTravelModes } = require("../services/travelMode.service");
const { appendJourneyEvents, approveJourneyRoute, createJourneyDraft, getJourneyForViewer, prepareRouteOptions } = require("../services/safetyJourney.service");
const User = require("../models/User");
const SafetyJourney = require("../models/SafetyJourney");

exports.listTravelModes = (req, res) => {
  res.json({ success: true, modes: listTravelModes() });
};

exports.createDraft = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("username").lean();
    if (!user) return res.status(401).json({ success: false, message: "Authenticated user not found." });
    const result = await createJourneyDraft({
      travellerId: req.user.userId,
      travellerUsername: user.username,
      input: req.body || {}
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Create safety journey draft failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not create the journey draft." });
  }
};


exports.getRoutes = async (req, res) => {
  try {
    const result = await prepareRouteOptions({
      journeyId: req.params.id,
      travellerId: req.user.userId
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Resolve safety journey routes failed:", error.message);
    const status = error.code === "ROUTING_NOT_CONFIGURED" ? 503
      : ["ROUTING_MODE_UNSUPPORTED", "INVALID_TRAVEL_MODE", "ORIGIN_UNRESOLVED", "DESTINATION_UNRESOLVED", "SAME_ENDPOINT"].includes(error.code) ? 422
      : error.code === "NO_ROUTE_FOUND" ? 404 : 502;
    return res.status(status).json({
      success: false,
      code: error.code || "ROUTING_ERROR",
      message: error.message || "Could not resolve route options."
    });
  }
};

exports.approveRoute = async (req, res) => {
  try {
    const result = await approveJourneyRoute({
      journeyId: req.params.id,
      travellerId: req.user.userId,
      optionId: req.body?.optionId
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Approve safety journey route failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not approve this route." });
  }
};


exports.appendEvents = async (req, res) => {
  try {
    const result = await appendJourneyEvents({
      journeyId: req.params.id,
      travellerId: req.user.userId,
      events: Array.isArray(req.body?.events) ? req.body.events : [req.body?.event || req.body]
    });
    if (result.status >= 400) return res.status(result.status).json(result.body);

    const journey = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId }).lean();
    if (journey && result.body.acceptedCount > 0) {
      const payload = {
        journeyId: String(journey._id),
        travellerId: String(journey.travellerId),
        travellerUsername: journey.travellerUsername,
        status: journey.status,
        transportModeId: journey.transportModeId,
        avatarKey: journey.avatarKey,
        origin: journey.origin,
        destination: journey.destination,
        route: journey.route,
        expectedArrivalAt: journey.expectedArrivalAt,
        lastConfirmedLocation: journey.lastConfirmedLocation,
        connectionStatus: journey.connectionStatus,
        remainingDistanceMeters: result.body.remainingDistanceMeters,
        locationFreshness: result.body.locationFreshness,
        arrivedAt: journey.arrivedAt
      };
      const io = req.app.get("io");
      for (const recipientId of journey.sharedWith || []) {
        io?.to("user:" + recipientId).emit("journey-update", payload);
        if (journey.status === "ARRIVED") io?.to("user:" + recipientId).emit("journey-arrived", {
          journeyId: String(journey._id),
          travellerUsername: journey.travellerUsername,
          destination: journey.destination?.label || journey.destinationText,
          arrivedAt: journey.arrivedAt
        });
      }
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Journey event sync failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not sync journey events." });
  }
};

exports.cancelJourney = async (req, res) => {
  try {
    const journey = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId });
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
    if (["ARRIVED", "CANCELLED", "COMPLETED"].includes(journey.status)) {
      return res.status(409).json({ success: false, message: "This journey has already ended." });
    }
    journey.status = "CANCELLED";
    journey.cancelledAt = new Date();
    await journey.save();
    const io = req.app.get("io");
    for (const recipientId of journey.sharedWith || []) {
      io?.to("user:" + recipientId).emit("journey-update", {
        journeyId: String(journey._id),
        travellerId: String(journey.travellerId),
        travellerUsername: journey.travellerUsername,
        status: journey.status,
        avatarKey: journey.avatarKey,
        message: "The traveller cancelled this journey."
      });
    }
    return res.json({ success: true, status: journey.status });
  } catch (error) {
    console.error("Cancel safety journey failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not cancel this journey." });
  }
};

exports.listMine = async (req, res) => {
  try {
    const journeys = await SafetyJourney.find({
      $or: [{ travellerId: req.user.userId }, { sharedWith: req.user.userId }],
      sharingEnabled: true
    }).sort({ createdAt: -1 }).limit(100).lean();
    return res.json({
      success: true,
      journeys: journeys.map(journey => ({
        id: String(journey._id),
        travellerId: String(journey.travellerId),
        travellerUsername: journey.travellerUsername,
        status: journey.status,
        transportModeId: journey.transportModeId,
        avatarKey: journey.avatarKey,
        originText: journey.originText,
        destinationText: journey.destinationText,
        expectedArrivalAt: journey.expectedArrivalAt,
        lastConfirmedLocation: journey.lastConfirmedLocation,
        updatedAt: journey.updatedAt
      }))
    });
  } catch (error) {
    console.error("List safety journeys failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load safety journeys." });
  }
};

exports.getOne = async (req, res) => {
  try {
    const journey = await getJourneyForViewer(req.params.id, req.user.userId);
    if (!journey || !journey.sharingEnabled) {
      return res.status(404).json({ success: false, message: "Journey not found or not shared with you." });
    }
    return res.json({ success: true, journey });
  } catch (error) {
    console.error("Get safety journey failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load this journey." });
  }
};
