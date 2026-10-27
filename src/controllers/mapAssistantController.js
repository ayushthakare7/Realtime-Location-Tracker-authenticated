// Reva map assistant: authorized context assembly, place descriptions and RAG delegation.
const User = require("../models/User");
const Location = require("../models/Location");
const LocationPoint = require("../models/LocationPoint");
const LocationVisit = require("../models/LocationVisit");
const LocationEvent = require("../models/LocationEvent");
const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
const { askRagService } = require("../services/ragClient.service");
const ragTasks = require("../services/ragTask.service");
const { placeLabel, reverseGeocode } = require("../services/locationEvents.service");
const { geocodePlace } = require("../services/geocoding.service");
const { findNearbyPlaces } = require("../services/nearbyPlaces.service");

const { distanceKm, isCurrentQuestion, isOwnCurrentQuestion, isGeoAddressQuestion, requestedUsername, isFallbackPlace, describeNearbyLocation } = require("../services/locationAnswerFormatting.service");

exports.askMap = async (req, res) => {
  try {
    const question = String(req.body.question || "").trim();
    if (!question || question.length > 500) return res.status(400).json({ success: false, message: "Question must be 1-500 characters." });
    if (req.body.aiConsent !== true) return res.status(400).json({ success: false, message: "Consent is required before sending location records to the assistant." });
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).lean();
    const friendIds = links.map(f => String(f.requester) === String(uid) ? f.recipient : f.requester);
    const users = await User.find({ _id: { $in: friendIds }, sharingEnabled: true }).select("_id username historyEnabled").lean();
    const names = new Map(users.map(u => [String(u._id), u.username]));
    const visibleIds = users.map(u => u._id);
    const [mine, others, visits] = await Promise.all([Location.findOne({ userId: uid }).lean(), visibleIds.length ? Location.find({ userId: { $in: visibleIds } }).lean() : [], LocationVisit.find({ userId: { $in: [uid, ...visibleIds] } }).lean()]);
    const visitByUser = new Map(visits.map(v => [String(v.userId), v]));
    const allVisibleUsers = [{ _id: uid, username: "you" }, ...users];
    const requested = requestedUsername(question, allVisibleUsers.map(u => u.username));
    const targetUser = requested ? allVisibleUsers.find(u => String(u.username).toLowerCase() === String(requested).toLowerCase()) : null;
    const ownCurrentQuestion = isOwnCurrentQuestion(question);

    if (isGeoAddressQuestion(question)) {
      const targetId = targetUser ? String(targetUser._id) : String(uid);
      const targetLocation = targetId === String(uid) ? mine : others.find(p => String(p.userId) === targetId);
      if (!targetLocation) return res.json({ success: true, answer: "I can't access a shared location for that person right now." });
      const geo = await reverseGeocode(targetLocation.latitude, targetLocation.longitude);
      const targetName = targetId === String(uid) ? "You" : (targetUser?.username || "That user");
      let locationDetails = describeNearbyLocation(geo, [], geo.placeName);
      try {
        const nearby = await findNearbyPlaces(targetLocation.latitude, targetLocation.longitude, 1000);
        locationDetails = describeNearbyLocation(geo, nearby, geo.placeName);
      } catch (error) {
        console.warn("[Reva] Nearby landmark/road lookup failed:", error.message);
      }
      if (!locationDetails.label) return res.json({ success: true, answer: `${targetName}'s coordinates are available, but a nearby road, named place, or region could not be resolved yet.` });
      return res.json({ success: true, answer: `${targetName}'s location appears to be: ${locationDetails.label}. Nearby place names are best-effort map matches.` });
    }

    // Handle "Is <friend> at/in <named place>?" as a geographic comparison.
    // Run this before the generic current-location response, which otherwise
    // ignores the place named in the question.
    if (targetUser && (isCurrentQuestion(question) || /\b(?:is|does)\b.*\b(?:in|at|near|inside|within)\b/i.test(question)) && !/\b(yesterday|last night|last week|last month|days? ago|weeks? ago|last year)\b/i.test(question)) {
      const placeMatch = question.match(/\b(?:inside|within|in|at|near)\s+(.+?)(?:[?.!]|$)/i);
      const candidatePlace = placeMatch
        ? placeMatch[1].replace(/\b(?:right now|currently|at present|today|please|exactly)\b/ig, " ").replace(/\s+/g, " ").trim()
        : "";
      const isPlaceQuestion = candidatePlace.length >= 3 &&
        !/^(?:the location|your location|my location|here|there|home|school|college)$/i.test(candidatePlace);
      if (isPlaceQuestion) {
        const targetId = String(targetUser._id);
        const targetLocation = targetId === String(uid) ? mine : others.find(point => String(point.userId) === targetId);
        const targetName = targetId === String(uid) ? "You" : targetUser.username;
        if (!targetLocation) {
          return res.json({ success: true, answer: "I cannot access a current shared location for " + targetName.toLowerCase() + " right now." });
        }
        let place = null;
        let geocodeError = null;
        try {
          place = await geocodePlace(candidatePlace);
        } catch (error) {
          geocodeError = error;
          console.warn("[Reva] Place geocoding failed; trying nearby landmark matching:", error.message);
        }

        let matchingLandmark = null;
        try {
          // This runs even when global geocoding fails: a nearby OSM feature can
          // identify the requested campus/place from the user's GPS point.
          const nearby = await findNearbyPlaces(targetLocation.latitude, targetLocation.longitude, 1500);
          const normalizedCandidate = candidatePlace.toLocaleLowerCase("en-IN").replace(/[^a-z0-9]+/g, " ").trim();
          const candidateTokens = normalizedCandidate.split(/\s+/).filter(token => token.length > 1);
          matchingLandmark = nearby
            .map(item => {
              const normalizedName = item.name.toLocaleLowerCase("en-IN").replace(/[^a-z0-9]+/g, " ").trim();
              const allTokensMatch = candidateTokens.length > 0 && candidateTokens.every(token => normalizedName.includes(token));
              const meaningfulNameMatch = normalizedName === normalizedCandidate ||
                (allTokensMatch && candidateTokens.length >= 2);
              return { ...item, meaningfulNameMatch };
            })
            .filter(item => item.meaningfulNameMatch)
            .sort((a, b) => a.distanceKm - b.distanceKm)[0] || null;
        } catch (error) {
          console.warn("[Reva] Named landmark comparison failed:", error.message);
        }

        if (place || matchingLandmark) {
          const km = place
            ? distanceKm(targetLocation.latitude, targetLocation.longitude, place.latitude, place.longitude)
            : matchingLandmark.distanceKm;
          const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(targetLocation.lastSeen).getTime()) / 60000));
          const proximityKm = Math.max(0.1, Number(process.env.PLACE_PROXIMITY_KM) || 1.5);
          const placeLabel = matchingLandmark
            ? matchingLandmark.name
            : [place.name, place.state, place.country].filter(Boolean).join(", ");
          const distanceToPlaceKm = matchingLandmark ? matchingLandmark.distanceKm : km;
          const matchEvidence = matchingLandmark ? "nearby mapped landmark" : "geocoded place point";
          const freshness = " The shared GPS point was updated " + ageMinutes + " minute(s) ago.";
          const staleAfterMinutes = Math.max(1, Number(process.env.LOCATION_STALE_MINUTES) || 15);
          if (ageMinutes > staleAfterMinutes) {
            return res.json({
              success: true,
              answer: "I cannot reliably confirm where " + targetName.toLowerCase() + " is right now because their latest shared GPS point is " + ageMinutes + " minute(s) old. At that recorded point, it was about " + distanceToPlaceKm.toFixed(2) + " km from " + placeLabel + " (" + matchEvidence + ", straight-line distance)."
            });
          }
          if (distanceToPlaceKm <= proximityKm) {
            return res.json({ success: true, answer: targetName + " appears to be near " + placeLabel + " (about " + distanceToPlaceKm.toFixed(2) + " km away, based on the " + matchEvidence + "). This indicates proximity, not confirmed entry inside the exact campus/building boundary." + freshness });
          }
          return res.json({ success: true, answer: targetName + " does not appear to be near " + placeLabel + ". Their latest shared GPS point is about " + distanceToPlaceKm.toFixed(2) + " km away in a straight line." + freshness });
        }
        if (geocodeError) {
          return res.json({ success: true, answer: "I can access the latest shared coordinates for " + targetName.toLowerCase() + ", but both place geocoding and nearby landmark lookup failed for \"" + candidatePlace + "\". Please try again shortly." });
        }
        return res.json({ success: true, answer: "I can access the latest shared coordinates for " + targetName.toLowerCase() + ", but neither the geocoder nor nearby map data could resolve \"" + candidatePlace + "\". Try adding its city or state." });
      }
    }

    if (isCurrentQuestion(question) || ownCurrentQuestion) {
      if (ownCurrentQuestion || (targetUser && String(targetUser._id) === String(uid))) {
        if (!mine) return res.json({ success: true, answer: "I don't have your latest location. Turn on location sharing and allow location access first." });
        // Resolve from the latest GPS point, not just the possibly stale visit label.
        const geo = await reverseGeocode(mine.latitude, mine.longitude);
        let place = geo.placeName;
        if (visitByUser.get(String(uid)) && place && !isFallbackPlace(place)) {
          await LocationVisit.updateOne({ _id: visitByUser.get(String(uid))._id }, { $set: { placeName: place, latitude: mine.latitude, longitude: mine.longitude, lastSeen: mine.lastSeen } });
        }
        const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(mine.lastSeen).getTime()) / 60000));
        const region = [geo.city, geo.state, geo.country].filter(Boolean).join(", ");
        let resolved = place && !isFallbackPlace(place) ? place : region;
        const previousVisit = visitByUser.get(String(uid));
        if (!resolved && previousVisit && previousVisit.placeName && !isFallbackPlace(previousVisit.placeName)) {
          const visitAge = Math.max(0, (Date.now() - new Date(previousVisit.lastSeen).getTime()) / 60000);
          const visitDriftKm = distanceKm(mine.latitude, mine.longitude, previousVisit.latitude, previousVisit.longitude);
          if (visitAge <= 15 && visitDriftKm <= 0.25) resolved = previousVisit.placeName;
        }
        let locationDetails = describeNearbyLocation(geo, [], resolved);
        try {
          const nearby = await findNearbyPlaces(mine.latitude, mine.longitude, 1000);
          locationDetails = describeNearbyLocation(geo, nearby, resolved);
        } catch (error) {
          console.warn("[Reva] Nearby landmark/road lookup failed:", error.message);
        }
        const coordinates = Number.isFinite(Number(mine.latitude)) && Number.isFinite(Number(mine.longitude)) ? " (GPS " + Number(mine.latitude).toFixed(5) + ", " + Number(mine.longitude).toFixed(5) + ")" : "";
        return res.json({ success: true, answer: locationDetails.label ? `Your latest shared location appears to be: ${locationDetails.label}${coordinates}. Updated ${ageMinutes} minute(s) ago. Nearby place names are best-effort map matches.` : `I have your latest GPS coordinates${coordinates}, but could not resolve a named road or place. Updated ${ageMinutes} minute(s) ago.` });
      }
      const target = targetUser && String(targetUser._id) !== String(uid) ? others.find(p => String(p.userId) === String(targetUser._id)) : null;
      if (!target) return res.json({ success: true, answer: "I can't access a current location for that person. They may not be sharing right now, or their latest location is unavailable." });
      // Always reverse-geocode the freshest point; a visit label may describe an older stop.
      const geo = await reverseGeocode(target.latitude, target.longitude);
      const visit = visitByUser.get(String(target.userId));
      const place = geo.placeName;
      if (visit && place && !isFallbackPlace(place)) {
        await LocationVisit.updateOne({ _id: visit._id }, { $set: { placeName: place, latitude: target.latitude, longitude: target.longitude, lastSeen: target.lastSeen } });
      }
      const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(target.lastSeen).getTime()) / 60000));
      const region = [geo.city, geo.state, geo.country].filter(Boolean).join(", ");
      let resolved = place && !isFallbackPlace(place) ? place : region;
      if (!resolved && visit && visit.placeName && !isFallbackPlace(visit.placeName)) {
        const visitAge = Math.max(0, (Date.now() - new Date(visit.lastSeen).getTime()) / 60000);
        const visitDriftKm = distanceKm(target.latitude, target.longitude, visit.latitude, visit.longitude);
        if (visitAge <= 15 && visitDriftKm <= 0.25) resolved = visit.placeName;
      }
      let locationDetails = describeNearbyLocation(geo, [], resolved);
      try {
        const nearby = await findNearbyPlaces(target.latitude, target.longitude, 1000);
        locationDetails = describeNearbyLocation(geo, nearby, resolved);
      } catch (error) {
        console.warn("[Reva] Nearby landmark/road lookup failed:", error.message);
      }
      const coordinates = Number.isFinite(Number(target.latitude)) && Number.isFinite(Number(target.longitude)) ? " (GPS " + Number(target.latitude).toFixed(5) + ", " + Number(target.longitude).toFixed(5) + ")" : "";
      const staleAfterMinutes = Math.max(1, Number(process.env.LOCATION_STALE_MINUTES) || 15);
      if (ageMinutes > staleAfterMinutes) {
        return res.json({ success: true, answer: `${target.username}'s last shared GPS point is ${ageMinutes} minute(s) old. The recorded location was: ${locationDetails.label || resolved || "an unnamed map location"}${coordinates}. I cannot confirm this is where they are right now.` });
      }
      if (locationDetails.label || resolved) return res.json({ success: true, answer: `${target.username}'s latest shared location appears to be: ${locationDetails.label || resolved}${coordinates}. Updated ${ageMinutes} minute(s) ago. Nearby place names are best-effort map matches.` });
      return res.json({ success: true, answer: `${target.username} is sharing a current location, but no named nearby road or place could be resolved. Their GPS coordinates are ${Number(target.latitude).toFixed(5)}, ${Number(target.longitude).toFixed(5)}; updated ${ageMinutes} minute(s) ago.` });
    }

    const distances = [];
    if (mine) for (const friend of others) {
      const km = distanceKm(mine.latitude, mine.longitude, friend.latitude, friend.longitude);
      distances.push({
        username: names.get(String(friend.userId)) || friend.username,
        distanceKm: Number(km.toFixed(2)),
        measuredAt: friend.lastSeen,
        meaning: "straight-line distance, not road distance"
      });
    }
    const context = {
      currentUserId: String(uid),
      currentUsername: req.user.username || "you",
      authorizedPeople: users.filter(user => user.historyEnabled !== false).map(user => ({
        id: String(user._id),
        username: user.username
      })),
      currentLocations: [
        ...(mine ? [{
          username: "you",
          placeName: visitByUser.get(String(uid))?.placeName || null,
          latitude: mine.latitude,
          longitude: mine.longitude,
          lastSeen: mine.lastSeen,
          sharingEnabled: true
        }] : []),
        ...others.map(p => ({
          username: names.get(String(p.userId)) || p.username,
          placeName: visitByUser.get(String(p.userId))?.placeName || null,
          latitude: p.latitude,
          longitude: p.longitude,
          lastSeen: p.lastSeen,
          sharingEnabled: true
        }))
      ],
      calculatedDistances: distances
    };
    // Node remains the API/auth layer; LangChain + LangGraph RAG runs in Python.
    const me = await User.findById(uid).select("historyEnabled").lean();
    const authorizedHistoryIds = [
      ...(me?.historyEnabled !== false ? [uid] : []),
      ...users.filter(user => user.historyEnabled !== false).map(user => user._id)
    ];
    // Render may take several minutes to wake the Python RAG service. Return
    // immediately and let the browser poll this authenticated task for its answer.
    const task = ragTasks.start(req.user.userId, async () => {
      const result = await askRagService({ question, userIds: authorizedHistoryIds, context });
      return result.answer || "I couldn't find enough information in the shared location history to answer that yet.";
    });
    return res.status(202).json({
      success: true,
      pending: true,
      taskId: task.id,
      message: "Reva AI is waking up. This can take a few minutes after inactivity."
    });
  } catch (e) {
    console.error("Reva assistant error:", e);
    const status = [400, 401, 403, 429].includes(e.status) ? e.status : 502;
    const message = status === 400 ? e.message : "Reva couldn't answer right now. Please try again.";
    res.status(status).json({ success: false, message });
  }
};


exports.askRagTaskStatus = (req, res) => {
  const task = ragTasks.getForUser(req.user.userId, req.params.taskId);
  if (!task) return res.status(404).json({ success: false, message: "Reva request not found or expired." });
  return res.json({ success: true, ...task });
};
