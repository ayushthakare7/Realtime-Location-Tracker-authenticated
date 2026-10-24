const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
const User = require("../models/User");
const { resolveTravelMode } = require("./travelMode.service");
const { resolveAndRoute } = require("./journeyRouting.service");

function validateJourneyDraft(input = {}) {
  const originText = String(input.originText || "").trim();
  const destinationText = String(input.destinationText || "").trim();
  if (!originText || originText.length > 200) {
    return { error: "originText is required and must be at most 200 characters." };
  }
  if (!destinationText || destinationText.length > 200) {
    return { error: "destinationText is required and must be at most 200 characters." };
  }
  const gracePeriodMinutes = input.gracePeriodMinutes === undefined ? 10 : Number(input.gracePeriodMinutes);
  if (!Number.isInteger(gracePeriodMinutes) || gracePeriodMinutes < 0 || gracePeriodMinutes > 180) {
    return { error: "gracePeriodMinutes must be a whole number from 0 to 180." };
  }
  const modeResult = resolveTravelMode(input.travelModeText || "", input.transportModeId || null);
  if (modeResult.status !== "resolved") {
    return {
      error: null,
      modeResult,
      draft: { originText, destinationText, gracePeriodMinutes }
    };
  }
  return {
    error: null,
    modeResult,
    draft: { originText, destinationText, gracePeriodMinutes }
  };
}

async function validateShareRecipients(travellerId, recipientIds = []) {
  if (!Array.isArray(recipientIds)) return { error: "sharedWith must be an array of friend IDs." };
  if (recipientIds.length > 100) return { error: "A journey can be shared with at most 100 friends." };
  const uniqueIds = [...new Set(recipientIds.map(id => String(id)))];
  if (uniqueIds.some(id => !/^[a-f\d]{24}$/i.test(id) || id === String(travellerId))) {
    return { error: "sharedWith contains an invalid friend ID." };
  }
  if (!uniqueIds.length) return { ids: [] };

  const links = await Friendship.find({
    status: "accepted",
    $or: [
      { requester: travellerId, recipient: { $in: uniqueIds } },
      { recipient: travellerId, requester: { $in: uniqueIds } }
    ]
  }).lean();
  const acceptedIds = new Set(links.map(link =>
    String(link.requester) === String(travellerId) ? String(link.recipient) : String(link.requester)
  ));
  const invalid = uniqueIds.filter(id => !acceptedIds.has(id));
  if (invalid.length) return { error: "Every recipient must be an accepted friend." };
  return { ids: uniqueIds };
}

async function createJourneyDraft({ travellerId, travellerUsername, input }) {
  const validated = validateJourneyDraft(input);
  if (validated.error) return { status: 400, body: { success: false, message: validated.error } };
  if (validated.modeResult.status !== "resolved") {
    return {
      status: 200,
      body: {
        success: true,
        requiresClarification: true,
        clarification: validated.modeResult.status,
        options: validated.modeResult.options || [],
        message: validated.modeResult.status === "missing"
          ? "Choose how you are travelling so Reva can use the correct avatar and route type."
          : validated.modeResult.status === "invalid_selection"
            ? "That travel mode is not supported. Please select a valid mode."
            : "Did you mean a bicycle or a motorcycle? Choose one so Reva displays the correct anime avatar."
      }
    };
  }

  const shareResult = await validateShareRecipients(travellerId, input.sharedWith || []);
  if (shareResult.error) return { status: 400, body: { success: false, message: shareResult.error } };

  const mode = validated.modeResult.mode;
  const journey = await SafetyJourney.create({
    travellerId,
    travellerUsername,
    status: "AWAITING_ROUTE_APPROVAL",
    transportModeId: mode.id,
    avatarKey: mode.avatarKey,
    modeSource: validated.modeResult.source,
    originText: validated.draft.originText,
    destinationText: validated.draft.destinationText,
    sharedWith: shareResult.ids,
    gracePeriodMinutes: validated.draft.gracePeriodMinutes
  });

  return {
    status: 201,
    body: {
      success: true,
      journey: {
        id: String(journey._id),
        status: journey.status,
        originText: journey.originText,
        destinationText: journey.destinationText,
        transportModeId: journey.transportModeId,
        avatarKey: journey.avatarKey,
        modeSource: journey.modeSource,
        sharedWith: journey.sharedWith.map(String),
        gracePeriodMinutes: journey.gracePeriodMinutes,
        routeApproved: false,
        message: "Journey draft saved. A route must be resolved and explicitly approved before tracking starts."
      }
    }
  };
}


async function prepareRouteOptions({ journeyId, travellerId }) {
  if (!/^[a-f\\d]{24}$/i.test(String(journeyId || ""))) {
    return { status: 400, body: { success: false, message: "Invalid journey ID." } };
  }
  const journey = await SafetyJourney.findOne({ _id: journeyId, travellerId });
  if (!journey) return { status: 404, body: { success: false, message: "Journey not found." } };
  if (!["AWAITING_ROUTE_APPROVAL", "DRAFT"].includes(journey.status)) {
    return { status: 409, body: { success: false, message: "Routes can only be changed before the journey starts." } };
  }

  const result = await resolveAndRoute({
    originText: journey.originText,
    destinationText: journey.destinationText,
    modeId: journey.transportModeId
  });
  journey.origin = result.origin;
  journey.destination = result.destination;
  journey.routeOptions = result.routes.map(route => ({
    optionId: route.optionId,
    routeLabels: route.routeLabels,
    provider: route.provider,
    providerRouteId: route.providerRouteId,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    encodedPolyline: route.encodedPolyline,
    approvedAt: null
  }));
  journey.status = "AWAITING_ROUTE_APPROVAL";
  await journey.save();

  return {
    status: 200,
    body: {
      success: true,
      journeyId: String(journey._id),
      status: journey.status,
      origin: journey.origin,
      destination: journey.destination,
      transportModeId: journey.transportModeId,
      avatarKey: journey.avatarKey,
      routes: journey.routeOptions.map(route => ({
        optionId: route.optionId,
        provider: route.provider,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        routeLabels: route.routeLabels,
        encodedPolyline: route.encodedPolyline
      })),
      requiresApproval: true
    }
  };
}

async function approveJourneyRoute({ journeyId, travellerId, optionId }) {
  if (!/^[a-f\\d]{24}$/i.test(String(journeyId || ""))) {
    return { status: 400, body: { success: false, message: "Invalid journey ID." } };
  }
  if (!optionId || typeof optionId !== "string" || optionId.length > 100) {
    return { status: 400, body: { success: false, message: "Select a route option returned by Reva." } };
  }
  const journey = await SafetyJourney.findOne({ _id: journeyId, travellerId });
  if (!journey) return { status: 404, body: { success: false, message: "Journey not found." } };
  if (journey.status !== "AWAITING_ROUTE_APPROVAL") {
    return { status: 409, body: { success: false, message: "This journey is not awaiting route approval." } };
  }
  const selected = journey.routeOptions.find(route => route.optionId === optionId);
  if (!selected || !journey.origin || !journey.destination || !selected.durationSeconds || !selected.distanceMeters) {
    return { status: 400, body: { success: false, message: "That route is unavailable. Request routes again and choose one of the returned options." } };
  }

  const now = new Date();
  journey.route = {
    optionId: selected.optionId,
    provider: selected.provider,
    providerRouteId: selected.providerRouteId,
    distanceMeters: selected.distanceMeters,
    durationSeconds: selected.durationSeconds,
    encodedPolyline: selected.encodedPolyline,
    routeLabels: selected.routeLabels,
    approvedAt: now
  };
  journey.routeOptions = [];
  journey.expectedArrivalAt = new Date(now.getTime() + selected.durationSeconds * 1000);
  journey.status = "ACTIVE";
  await journey.save();

  return {
    status: 200,
    body: {
      success: true,
      journey: {
        id: String(journey._id),
        status: journey.status,
        transportModeId: journey.transportModeId,
        avatarKey: journey.avatarKey,
        origin: journey.origin,
        destination: journey.destination,
        route: journey.route,
        expectedArrivalAt: journey.expectedArrivalAt,
        gracePeriodMinutes: journey.gracePeriodMinutes,
        message: "Route approved. Journey monitoring is now active."
      }
    }
  };
}

async function getJourneyForViewer(journeyId, viewerId) {
  if (!/^[a-f\d]{24}$/i.test(String(journeyId || ""))) return null;
  const journey = await SafetyJourney.findOne({
    _id: journeyId,
    $or: [{ travellerId: viewerId }, { sharedWith: viewerId }]
  }).lean();
  if (!journey) return null;
  return {
    id: String(journey._id),
    travellerId: String(journey.travellerId),
    travellerUsername: journey.travellerUsername,
    status: journey.status,
    transportModeId: journey.transportModeId,
    avatarKey: journey.avatarKey,
    originText: journey.originText,
    destinationText: journey.destinationText,
    route: journey.route || null,
    expectedArrivalAt: journey.expectedArrivalAt,
    gracePeriodMinutes: journey.gracePeriodMinutes,
    lastConfirmedLocation: journey.lastConfirmedLocation,
    sharingEnabled: journey.sharingEnabled,
    arrivedAt: journey.arrivedAt,
    updatedAt: journey.updatedAt
  };
}

module.exports = { approveJourneyRoute, createJourneyDraft, getJourneyForViewer, prepareRouteOptions, validateJourneyDraft, validateShareRecipients };
