const { listTravelModes } = require("../services/travelMode.service");
const { createJourneyDraft, getJourneyForViewer } = require("../services/safetyJourney.service");
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
