const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
const User = require("../models/User");
const Location = require("../models/Location");
const { resolveTravelMode } = require("./travelMode.service");
const { resolveAndRoute } = require("./journeyRouting.service");
const { calculateRemainingDistanceMeters } = require("./routeProgress.service");

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

  const originIsCurrentLocation = /^(my )?(current location|current position|here|my location)$/i.test(String(journey.originText || "").trim());
  let currentOrigin = null;
  if (originIsCurrentLocation) {
    const latest = await Location.findOne({ userId: travellerId }).lean();
    if (!latest || !latest.lastSeen || Date.now() - new Date(latest.lastSeen).getTime() > 5 * 60 * 1000) {
      const error = new Error("Your latest GPS location is missing or older than 5 minutes. Update location sharing, or enter a specific origin.");
      error.code = "ORIGIN_LOCATION_STALE";
      throw error;
    }
    currentOrigin = { latitude: latest.latitude, longitude: latest.longitude };
  }
  const result = await resolveAndRoute({
    originText: journey.originText,
    destinationText: journey.destinationText,
    modeId: journey.transportModeId,
    currentOrigin
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


async function appendJourneyEvents({ journeyId, travellerId, events }) {
  if (!/^[a-f\\d]{24}$/i.test(String(journeyId || ""))) {
    return { status: 400, body: { success: false, message: "Invalid journey ID." } };
  }
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) {
    return { status: 400, body: { success: false, message: "Send between 1 and 100 journey events per sync request." } };
  }
  const journey = await SafetyJourney.findOne({ _id: journeyId, travellerId });
  if (!journey) return { status: 404, body: { success: false, message: "Journey not found." } };
  if (["CANCELLED", "COMPLETED", "ARRIVED"].includes(journey.status)) {
    const terminalDuplicates = events.every(event => event && typeof event.eventId === "string" && journey.eventIds.includes(event.eventId.trim()));
    if (terminalDuplicates) {
      return { status: 200, body: { success: true, acceptedCount: 0, duplicateEventIds: events.map(event => event.eventId.trim()), status: journey.status, lastConfirmedLocation: journey.lastConfirmedLocation } };
    }
    return { status: 409, body: { success: false, message: "This journey no longer accepts progress events." } };
  }

  const allowedTypes = new Set(["location", "check_in", "arrival", "offline", "online", "emergency"]);
  const now = new Date();
  const accepted = [];
  const duplicates = [];
  for (const input of events) {
    if (!input || typeof input.eventId !== "string" || !input.eventId.trim() || input.eventId.length > 128) {
      return { status: 400, body: { success: false, message: "Each event needs a unique eventId of at most 128 characters." } };
    }
    const eventId = input.eventId.trim();
    if (journey.eventIds.includes(eventId) || accepted.some(event => event.eventId === eventId)) {
      duplicates.push(eventId);
      continue;
    }
    if (!allowedTypes.has(input.type)) {
      return { status: 400, body: { success: false, message: "Unsupported journey event type." } };
    }
    const recordedAt = input.recordedAt ? new Date(input.recordedAt) : null;
    if (!recordedAt || Number.isNaN(recordedAt.getTime()) || recordedAt.getTime() > now.getTime() + 5 * 60 * 1000 || recordedAt.getTime() < now.getTime() - 7 * 24 * 60 * 60 * 1000) {
      return { status: 400, body: { success: false, message: "Event timestamp must be valid, no more than 5 minutes in the future, and no older than 7 days." } };
    }

    let latitude = null;
    let longitude = null;
    let accuracyMeters = null;
    if (input.type === "location") {
      latitude = Number(input.latitude);
      longitude = Number(input.longitude);
      accuracyMeters = input.accuracyMeters == null ? null : Number(input.accuracyMeters);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
          (accuracyMeters !== null && (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 10000))) {
        return { status: 400, body: { success: false, message: "Location event needs valid coordinates and optional accuracy from 0 to 10000 metres." } };
      }
    }
    accepted.push({
      eventId,
      type: input.type,
      recordedAt,
      receivedAt: now,
      latitude,
      longitude,
      accuracyMeters,
      note: input.note == null ? null : String(input.note).slice(0, 500),
      source: "device"
    });
  }

  if (!accepted.length) {
    return {
      status: 200,
      body: { success: true, acceptedCount: 0, duplicateEventIds: duplicates, status: journey.status, lastConfirmedLocation: journey.lastConfirmedLocation }
    };
  }

  for (const event of accepted) {
    journey.events.push(event);
    journey.eventIds.push(event.eventId);
    if (event.type === "location") {
      const currentRecordedAt = journey.lastConfirmedLocation?.recordedAt ? new Date(journey.lastConfirmedLocation.recordedAt).getTime() : -Infinity;
      if (event.recordedAt.getTime() >= currentRecordedAt) {
        journey.lastConfirmedLocation = {
          latitude: event.latitude,
          longitude: event.longitude,
          recordedAt: event.recordedAt,
          receivedAt: now,
          accuracyMeters: event.accuracyMeters,
          placeLabel: null
        };
      }
    } else if (event.type === "offline" || event.type === "online") {
      // Queued offline events can arrive out of order. Preserve the state
      // belonging to the newest recorded event rather than request order.
      const previousConnectionAt = journey.connectionStatusUpdatedAt
        ? new Date(journey.connectionStatusUpdatedAt).getTime() : -Infinity;
      if (event.recordedAt.getTime() >= previousConnectionAt) {
        journey.connectionStatus = event.type;
        journey.connectionStatusUpdatedAt = event.recordedAt;
      }
    } else if (event.type === "check_in") {
      if (["OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED"].includes(journey.status)) journey.status = "ACTIVE";
      journey.checkInRequestedAt = null;
    } else if (event.type === "arrival") {
      journey.status = "ARRIVED";
      journey.arrivedAt = event.recordedAt;
    } else if (event.type === "emergency") {
      journey.status = "EMERGENCY_ALERTED";
      journey.alertSentAt = now;
    }
  }

  // Bound document growth while keeping a recent deduplication window for offline retries.
  if (journey.events.length > 1000) journey.events = journey.events.slice(-1000);
  if (journey.eventIds.length > 2000) journey.eventIds = journey.eventIds.slice(-2000);
  await journey.save();

  const last = journey.lastConfirmedLocation;
  const remainingDistanceMeters = last && journey.route?.encodedPolyline
    ? calculateRemainingDistanceMeters(journey.route.encodedPolyline, last.latitude, last.longitude)
    : null;
  return {
    status: 200,
    body: {
      success: true,
      acceptedCount: accepted.length,
      duplicateEventIds: duplicates,
      status: journey.status,
      connectionStatus: journey.connectionStatus,
      arrivedAt: journey.arrivedAt,
      lastConfirmedLocation: journey.lastConfirmedLocation,
      remainingDistanceMeters,
      locationFreshness: last?.recordedAt
        ? (now.getTime() - new Date(last.recordedAt).getTime() > 2 * 60 * 1000 ? "stale" : "recent")
        : "unavailable"
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
  if (String(journey.travellerId) !== String(viewerId)) {
    if (!journey.sharingEnabled || !["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED"].includes(journey.status)) return null;
    const friendship = await Friendship.exists({
      status: "accepted",
      $or: [
        { requester: viewerId, recipient: journey.travellerId },
        { requester: journey.travellerId, recipient: viewerId }
      ]
    });
    if (!friendship) return null;
  }
  const lastLocation = journey.lastConfirmedLocation;
  const remainingDistanceMeters = lastLocation && journey.route?.encodedPolyline
    ? calculateRemainingDistanceMeters(journey.route.encodedPolyline, lastLocation.latitude, lastLocation.longitude)
    : null;
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
    connectionStatus: journey.connectionStatus || "unknown",
    connectionStatusUpdatedAt: journey.connectionStatusUpdatedAt || null,
    remainingDistanceMeters,
    locationFreshness: lastLocation?.recordedAt
      ? (Date.now() - new Date(lastLocation.recordedAt).getTime() > 2 * 60 * 1000 ? "stale" : "recent")
      : "unavailable",
    arrivedAt: journey.arrivedAt,
    updatedAt: journey.updatedAt
  };
}

module.exports = { appendJourneyEvents, approveJourneyRoute, createJourneyDraft, getJourneyForViewer, prepareRouteOptions, validateJourneyDraft, validateShareRecipients };
