const { listTravelModes } = require("../services/travelMode.service");
const { appendJourneyEvents, approveJourneyRoute, createJourneyDraft, getJourneyForViewer, prepareRouteOptions } = require("../services/safetyJourney.service");
const User = require("../models/User");
const SafetyJourney = require("../models/SafetyJourney");
const SafetyNotification = require("../models/SafetyNotification");
const { notifyJourneyRecipients } = require("../services/safetyNotification.service");


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
      : ["ROUTING_MODE_UNSUPPORTED", "INVALID_TRAVEL_MODE", "ORIGIN_UNRESOLVED", "ORIGIN_LOCATION_STALE", "DESTINATION_UNRESOLVED", "SAME_ENDPOINT"].includes(error.code) ? 422
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
    if (result.status === 200) {
      const journey = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId }).lean();
      if (journey && journey.sharingEnabled && journey.sharedWith?.length) {
        await notifyJourneyRecipients({
          io: req.app.get("io"),
          journey,
          recipients: journey.sharedWith,
          type: "journey_shared",
          title: "A friend is sharing a Safety Travel journey",
          body: journey.travellerUsername + " started a shared journey to " + (journey.destination?.label || journey.destinationText) + ". Open Safety Travel to follow the approved route.",
          payload: { journeyId: String(journey._id), status: journey.status, destination: journey.destination?.label || journey.destinationText, expectedArrivalAt: journey.expectedArrivalAt },
          keySuffix: "shared"
        });
        for (const recipientId of journey.sharedWith) {
          req.app.get("io")?.to("user:" + recipientId).emit("journey-shared", {
            journeyId: String(journey._id),
            travellerId: String(journey.travellerId),
            travellerUsername: journey.travellerUsername,
            status: journey.status,
            avatarKey: journey.avatarKey,
            transportModeId: journey.transportModeId,
            destination: journey.destination,
            expectedArrivalAt: journey.expectedArrivalAt
          });
        }
      }
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Approve safety journey route failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not approve this route." });
  }
};


exports.appendEvents = async (req, res) => {
  try {
    const incomingEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body?.event || req.body];
    const beforeJourney = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId }).lean();
    const result = await appendJourneyEvents({
      journeyId: req.params.id,
      travellerId: req.user.userId,
      events: incomingEvents
    });
    if (result.status >= 400) return res.status(result.status).json(result.body);

    const journey = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId }).lean();
    if (journey && result.body.acceptedCount > 0) {
      const io = req.app.get("io");
      if (journey.status === "EMERGENCY_ALERTED" && incomingEvents.some(event => event?.type === "emergency")) {
        await notifyJourneyRecipients({
          io,
          journey,
          recipients: journey.sharingEnabled ? journey.sharedWith : [],
          type: "journey_emergency",
          title: "Emergency alert from your friend",
          body: journey.travellerUsername + " explicitly requested help during their Safety Travel journey. Try contacting them and use local emergency services if appropriate.",
          payload: { journeyId: String(journey._id), status: journey.status, alertSentAt: journey.alertSentAt },
          keySuffix: "emergency"
        });
      } else if (journey.status === "ARRIVED") {
        await notifyJourneyRecipients({
          io,
          journey,
          recipients: journey.sharingEnabled ? journey.sharedWith : [],
          type: "journey_arrived",
          title: "Your friend has arrived",
          body: journey.travellerUsername + " has arrived at " + (journey.destination?.label || journey.destinationText) + ".",
          payload: { journeyId: String(journey._id), status: journey.status, arrivedAt: journey.arrivedAt, destination: journey.destination?.label || journey.destinationText },
          keySuffix: "arrived"
        });
      } else if (["ALERT_SENT", "EMERGENCY_ALERTED"].includes(beforeJourney?.status) && incomingEvents.some(event => event?.type === "check_in")) {
        await notifyJourneyRecipients({
          io,
          journey,
          recipients: journey.sharingEnabled ? journey.sharedWith : [],
          type: "journey_safe_followup",
          title: "Your friend checked in",
          body: journey.travellerUsername + " has responded to the safety check-in. Their journey may still be in progress.",
          payload: { journeyId: String(journey._id), status: journey.status },
          keySuffix: "safe-followup"
        });
      }
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
      for (const recipientId of (journey.sharingEnabled ? journey.sharedWith : []) || []) {
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


exports.setJourneySharing = async (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ success: false, message: "enabled must be true or false." });
    }
    const journey = await SafetyJourney.findOne({ _id: req.params.id, travellerId: req.user.userId });
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
    if (["ARRIVED", "CANCELLED", "COMPLETED"].includes(journey.status) && req.body.enabled) {
      return res.status(409).json({ success: false, message: "A completed journey cannot resume sharing." });
    }
    journey.sharingEnabled = req.body.enabled;
    await journey.save();
    const io = req.app.get("io");
    for (const recipientId of journey.sharedWith || []) {
      if (!journey.sharingEnabled) {
        io?.to("user:" + recipientId).emit("journey-sharing-stopped", { journeyId: String(journey._id), travellerId: String(journey.travellerId) });
      } else {
        io?.to("user:" + recipientId).emit("journey-update", {
          journeyId: String(journey._id), travellerId: String(journey.travellerId),
          travellerUsername: journey.travellerUsername, status: journey.status,
          avatarKey: journey.avatarKey, transportModeId: journey.transportModeId,
          origin: journey.origin, destination: journey.destination, route: journey.route,
          expectedArrivalAt: journey.expectedArrivalAt,
          lastConfirmedLocation: journey.lastConfirmedLocation,
          connectionStatus: journey.connectionStatus
        });
      }
    }
    return res.json({ success: true, sharingEnabled: journey.sharingEnabled });
  } catch (error) {
    console.error("Set journey sharing failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not update journey sharing." });
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
    await notifyJourneyRecipients({
      io: req.app.get("io"), journey, recipients: journey.sharingEnabled ? journey.sharedWith : [],
      type: "journey_cancelled", title: "Journey cancelled",
      body: journey.travellerUsername + " cancelled their shared journey.",
      payload: { journeyId: String(journey._id), status: journey.status }, keySuffix: "cancelled"
    });
    const io = req.app.get("io");
    for (const recipientId of (journey.sharingEnabled ? journey.sharedWith : []) || []) {
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
      $or: [
        { travellerId: req.user.userId },
        { sharedWith: req.user.userId, sharingEnabled: true, status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED"] } }
      ]
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
    if (!journey || (!journey.sharingEnabled && journey.travellerId !== String(req.user.userId))) {
      return res.status(404).json({ success: false, message: "Journey not found or not shared with you." });
    }
    return res.json({ success: true, journey });
  } catch (error) {
    console.error("Get safety journey failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load this journey." });
  }
};
