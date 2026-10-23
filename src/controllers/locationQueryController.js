const Location = require("../models/Location");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { askMap } = require("./trackerController");
const { understandLocationQuestion } = require("../services/gemini.service");
const { geocodePlace } = require("../services/geocoding.service");
const { planDistanceQuestion } = require("../services/locationQueryPlanner.service");

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeCity(city) {
  try {
    return await geocodePlace(city);
  } catch (error) {
    console.error("[Geocoding] Failed to resolve destination:", error.message);
    return null;
  }
}

async function getRoadRoute(fromLat, fromLon, toLat, toLon) {
  const coordinates = `${fromLon},${fromLat};${toLon},${toLat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false&alternatives=false&steps=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": "PrivacyAwareLocationTracker/1.0" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes?.length) throw new Error(data.code || "No route found");
  return {
    distanceKm: Number(data.routes[0].distance) / 1000,
    durationMinutes: Number(data.routes[0].duration) / 60
  };
}

function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours === 0) return `${remaining} min`;
  if (remaining === 0) return `${hours} hr`;
  return `${hours} hr ${remaining} min`;
}

async function isAcceptedFriend(userId, friendId) {
  return Friendship.exists({
    status: "accepted",
    $or: [
      { requester: userId, recipient: friendId },
      { requester: friendId, recipient: userId }
    ]
  });
}

async function resolveAuthorizedPerson(currentUserId, name) {
  if (!name) return null;
  const person = await User.findOne({ username: new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
    .select("_id username sharingEnabled")
    .lean();
  if (!person) return null;
  if (String(person._id) === String(currentUserId)) return person;
  const accepted = await isAcceptedFriend(currentUserId, person._id);
  return accepted ? person : null;
}

async function getCurrentLocation(userId) {
  return Location.findOne({ userId }).lean();
}

async function resolveEndpoint(req, type, name) {
  if (type === "person" && name === "me") {
    const location = await getCurrentLocation(req.user.userId);
    return location ? { location, label: "you" } : { error: "I don't have your latest location." };
  }
  if (type === "person") {
    const person = await resolveAuthorizedPerson(req.user.userId, name);
    if (!person) return { error: `I couldn't find an accepted friend matching ${name || "that person"}.` };
    if (String(person._id) !== String(req.user.userId) && !person.sharingEnabled) {
      return { error: `${person.username} is not currently sharing their location.` };
    }
    const location = await getCurrentLocation(person._id);
    if (!location) return { error: `I don't have a latest shared location for ${person.username}.` };
    return { location, label: person.username };
  }
  if (type === "place" && name) {
    const location = await geocodeCity(name);
    if (!location) return { error: `I couldn't resolve "${name}" to a specific place. Try adding a country or region.` };
    const region = [location.state, location.country].filter(Boolean).join(", ");
    return { location, label: [location.name, region].filter(Boolean).join(", ") };
  }
  return { error: "I couldn't identify both endpoints. Please name the people or places." };
}

async function answerDistanceQuestion(req, parsed) {
  const originType = parsed.originType || (parsed.origin === "place" ? "place" : "person");
  const originName = parsed.origin === "me" ? "me" : (parsed.origin === "place" ? parsed.originPlace || parsed.originPerson : parsed.originPerson);
  const origin = originType === "person" && parsed.origin === "me"
    ? await resolveEndpoint(req, "person", "me")
    : await resolveEndpoint(req, originType, originName);
  if (origin.error) return origin.error;

  const destinationType = parsed.destinationType || "person";
  const destination = await resolveEndpoint(req, destinationType, parsed.destination);
  if (destination.error) return destination.error;

  const straightLineKm = distanceKm(
    origin.location.latitude,
    origin.location.longitude,
    destination.location.latitude,
    destination.location.longitude
  );

  try {
    const route = await getRoadRoute(
      origin.location.latitude,
      origin.location.longitude,
      destination.location.latitude,
      destination.location.longitude
    );
    return `${destination.label} is approximately ${route.distanceKm.toFixed(1)} km away from ${origin.label} by road. Estimated driving time is about ${formatDuration(route.durationMinutes)}. Straight-line distance is ${straightLineKm.toFixed(1)} km.`;
  } catch (error) {
    console.error("Road routing failed:", error.message);
    return `${destination.label} is approximately ${straightLineKm.toFixed(2)} km away from ${origin.label} in a straight line. I couldn't get a road route right now.`;
  }
}


async function answerNearestPerson(req, parsed) {
  let targetLocation;
  let targetLabel;
  let excludedUserId = null;

  if (parsed.targetType === "me") {
    targetLocation = await getCurrentLocation(req.user.userId);
    targetLabel = "your current location";
    if (!targetLocation) return "I don't have your latest location to compare against.";
  } else if (parsed.targetType === "person") {
    const targetPerson = await resolveAuthorizedPerson(req.user.userId, parsed.target);
    if (!targetPerson) return \`I couldn't find an accepted friend matching \${parsed.target || "that person"}.\`;
    if (String(targetPerson._id) !== String(req.user.userId) && !targetPerson.sharingEnabled) {
      return \`\${targetPerson.username} is not currently sharing their location.\`;
    }
    targetLocation = await getCurrentLocation(targetPerson._id);
    targetLabel = targetPerson.username + "'s location";
    excludedUserId = String(targetPerson._id);
    if (!targetLocation) return \`I don't have a latest shared location for \${targetPerson.username}.\`;
  } else if (parsed.targetType === "place") {
    targetLocation = await geocodeCity(parsed.target);
    targetLabel = parsed.target;
    if (!targetLocation) return \`I couldn't resolve "\${parsed.target}" to a specific place. Try adding a country or region.\`;
  } else {
    return "Please specify whose location or which place to compare.";
  }

  const links = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.userId }, { recipient: req.user.userId }]
  }).lean();
  const friendIds = links.map(link =>
    String(link.requester) === String(req.user.userId) ? link.recipient : link.requester
  ).filter(id => String(id) !== String(req.user.userId) && String(id) !== excludedUserId);

  const friends = await User.find({ _id: { $in: friendIds }, sharingEnabled: true })
    .select("_id username").lean();
  if (!friends.length) return "I couldn't find any other accepted friends who are currently sharing their locations.";

  const locations = await Location.find({ userId: { $in: friends.map(friend => friend._id) } }).lean();
  const byUserId = new Map(locations.map(location => [String(location.userId), location]));
  const candidates = friends.map(friend => {
    const location = byUserId.get(String(friend._id));
    if (!location) return null;
    return {
      username: friend.username,
      distanceKm: distanceKm(
        targetLocation.latitude, targetLocation.longitude,
        location.latitude, location.longitude
      )
    };
  }).filter(Boolean);

  if (!candidates.length) return "I don't have current shared coordinates for your friends yet.";
  candidates.sort((a, b) => parsed.relation === "farthest" ? b.distanceKm - a.distanceKm : a.distanceKm - b.distanceKm);
  const winner = candidates[0];
  const adjective = parsed.relation === "farthest" ? "farthest" : "closest";
  return `${winner.username} is currently the ${adjective} sharing friend to ${targetLabel}, at approximately ${winner.distanceKm.toFixed(2)} km in a straight line. This compares the latest available shared locations, not road distances.`;
}

// Local planning is a resilient fallback when the hosted language model is
// unavailable or returns endpoints that do not match the user's words.
async function fallbackParseDistanceQuestion(req, question) {
  const links = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.userId }, { recipient: req.user.userId }]
  }).lean();
  const friendIds = links.map(link =>
    String(link.requester) === String(req.user.userId) ? link.recipient : link.requester
  );
  const friends = await User.find({
    _id: { $in: friendIds },
    sharingEnabled: true
  }).select("_id username").lean();

  return planDistanceQuestion(question, friends.map(friend => friend.username));
}

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();
  if (!question || question.length > 500) {
    return res.status(400).json({ success: false, message: "Question must be 1-500 characters." });
  }
  if (req.body.aiConsent !== true) {
    return res.status(400).json({ success: false, message: "Consent is required before sending location records to the assistant." });
  }

  let parsed = null;
  try {
    // The LLM maps natural language to structured endpoints; calculations remain deterministic.
    parsed = await understandLocationQuestion(question);
  } catch (error) {
    console.error("Location question understanding failed:", error.message);
  }

  // Prefer exact authorized usernames detected locally when available, even if the
  // LLM returned a distance intent with the wrong endpoints.
  try {
    parsed = await fallbackParseDistanceQuestion(req, question) || parsed;
  } catch (error) {
    console.error("Local distance intent fallback failed:", error.message);
  }

  if (parsed?.intent === "nearest_person") {
    try {
      const answer = await answerNearestPerson(req, parsed);
      return res.json({ success: true, answer });
    } catch (error) {
      console.error("Nearest-person query failed:", error.message);
      return res.status(502).json({ success: false, message: "I understood the comparison, but couldn't calculate it right now. Please try again." });
    }
  }

  if (parsed?.intent === "distance") {
    try {
      const answer = await answerDistanceQuestion(req, parsed);
      if (answer) return res.json({ success: true, answer });
    } catch (error) {
      console.error("Distance execution failed:", error.message);
      return res.status(502).json({ success: false, message: "I understood this as a distance question, but couldn't calculate it right now. Please try again." });
    }
  }

  return askMap(req, res);
};
