const Location = require("../models/Location");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { askMap } = require("./trackerController");
const { understandLocationQuestion } = require("../services/gemini.service");
const { geocodePlace } = require("../services/geocoding.service");

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

async function answerDistanceQuestion(req, parsed) {
  let fromLocation;
  let fromLabel;
  let toLocation;
  let toLabel;

  if (parsed.origin === "me") {
    fromLocation = await getCurrentLocation(req.user.userId);
    fromLabel = "you";
  } else if (parsed.origin === "friend") {
    const friend = await resolveAuthorizedPerson(req.user.userId, parsed.originPerson);
    if (!friend) return `I couldn't find an accepted friend matching ${parsed.originPerson || "that person"}.`;
    if (!friend.sharingEnabled) return `${friend.username} is not currently sharing their location.`;
    fromLocation = await getCurrentLocation(friend._id);
    fromLabel = friend.username;
  } else {
    return null;
  }

  if (!fromLocation) {
    return `I don't have a latest shared location for ${fromLabel}.`;
  }

  if (parsed.destinationType === "person") {
    const person = await resolveAuthorizedPerson(req.user.userId, parsed.destination);
    if (!person) return `I couldn't find an accepted friend matching ${parsed.destination || "that person"}.`;
    if (!person.sharingEnabled) return `${person.username} is not currently sharing their location.`;
    toLocation = await getCurrentLocation(person._id);
    toLabel = person.username;
    if (!toLocation) return `I don't have a latest shared location for ${toLabel}.`;
  } else if (parsed.destinationType === "place" && parsed.destination) {
    const destination = await geocodeCity(parsed.destination);
    if (!destination) return `I couldn't resolve ${parsed.destination} to a specific place. Try adding a country or region, for example Colombo, Sri Lanka.`;
    toLocation = destination;
    toLabel = `${destination.name}${destination.state ? `, ${destination.state}` : ""}`;
  } else {
    return null;
  }

  const straightLineKm = distanceKm(
    fromLocation.latitude,
    fromLocation.longitude,
    toLocation.latitude,
    toLocation.longitude
  );

  try {
    const route = await getRoadRoute(
      fromLocation.latitude,
      fromLocation.longitude,
      toLocation.latitude,
      toLocation.longitude
    );
    return `${toLabel} is approximately ${route.distanceKm.toFixed(1)} km away from ${fromLabel} by road. Estimated driving time is about ${formatDuration(route.durationMinutes)}. Straight-line distance is ${straightLineKm.toFixed(1)} km.`;
  } catch (error) {
    console.error("Road routing failed:", error.message);
    return `${toLabel} is approximately ${straightLineKm.toFixed(2)} km away from ${fromLabel} in a straight line. I couldn't get a road route right now.`;
  }
}


function escapeRegex(value) {
  return String(value).replace(/[.*+?^$()|[\]\\]/g, "\\exports.ask = async (req, res) => {");
}

// Resilient local fallback for when the language-model parser is unavailable.
// Only accepted friends with sharing enabled are candidate people; execution
// checks friendship and sharing permissions again before reading coordinates.
async function fallbackParseDistanceQuestion(req, question) {
  const distanceLike = /\b(distance|how far|far away|away from|separate|separation|closer|closest|nearest|nearer|nearby|kilomet(?:er|re)s?|miles?|met(?:er|re)s?)\b/i.test(question);
  if (!distanceLike) return null;

  const links = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.userId }, { recipient: req.user.userId }]
  }).lean();
  const friendIds = links.map(link =>
    String(link.requester) === String(req.user.userId) ? link.recipient : link.requester
  );
  const friends = await User.find({ _id: { $in: friendIds }, sharingEnabled: true })
    .select("_id username")
    .lean();

  const matchedFriends = friends
    .filter(friend => new RegExp("(^|[^a-z0-9_])" + escapeRegex(friend.username) + "([^a-z0-9_]|$)", "i").test(question))
    .sort((a, b) => question.toLowerCase().indexOf(a.username.toLowerCase()) - question.toLowerCase().indexOf(b.username.toLowerCase()));

  if (matchedFriends.length >= 2) {
    return {
      intent: "distance",
      origin: "friend",
      originPerson: matchedFriends[0].username,
      destination: matchedFriends[1].username,
      destinationType: "person"
    };
  }

  const mentionsSelf = /\b(me|myself|my location|where i am|where am i)\b/i.test(question);
  if (matchedFriends.length === 1) {
    const friend = matchedFriends[0];
    const withoutFriend = question.replace(new RegExp(escapeRegex(friend.username), "ig"), " ");
    const place = withoutFriend
      .replace(/\b(?:how|far|is|are|the|distance|between|from|to|of|for|me|myself|my|location|current|right|now|please|calculate|work|out|tell|what|would|be|in|at|and|away|separate|separation|closer|closest|nearest|nearer|nearby|kilometers?|kilometres?|kms?|miles?|meters?|metres?)\b/gi, " ")
      .replace(/[?!,.;:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (mentionsSelf && !place) {
      return { intent: "distance", origin: "me", originPerson: null, destination: friend.username, destinationType: "person" };
    }
    if (place) {
      return { intent: "distance", origin: "friend", originPerson: friend.username, destination: place, destinationType: "place" };
    }
  }

  if (mentionsSelf) {
    const place = question
      .replace(/\b(?:me|myself|my|i|am|where|how|far|is|are|the|distance|between|from|to|of|for|location|current|right|now|please|calculate|work|out|tell|what|would|be|in|at|and|away|kilometers?|kilometres?|kms?|miles?|meters?|metres?)\b/gi, " ")
      .replace(/[?!,.;:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (place) return { intent: "distance", origin: "me", originPerson: null, destination: place, destinationType: "place" };
  }

  return null;
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

  // Distance questions should not depend entirely on an external LLM being reachable.
  if (parsed?.intent !== "distance") {
    try {
      parsed = await fallbackParseDistanceQuestion(req, question) || parsed;
    } catch (error) {
      console.error("Local distance intent fallback failed:", error.message);
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
