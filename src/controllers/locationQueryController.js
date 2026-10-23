const Location = require("../models/Location");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { askMap } = require("./trackerController");
const { understandLocationQuestion } = require("../services/gemini.service");
const { geocodePlace } = require("../services/geocoding.service");
const { inferPersonDistanceIntent } = require("../services/personDistanceIntent.service");

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
    if (!destination) return `I couldn't resolve ${parsed.destination} to a location. Try adding a country or region, for example New York, USA.`;
    toLocation = destination;
    toLabel = [destination.name, destination.state, destination.country].filter(Boolean).join(", ");
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

async function inferFriendPlaceDistanceIntent(question, currentUserId) {
  const q = String(question || "").trim();
  if (!/\b(distance|far|apart|kilomet(?:er|re)s?|miles?|how long|travel time|drive|driving)\b/i.test(q)) return null;

  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: currentUserId }, { recipient: currentUserId }]
  }).select("requester recipient").lean();
  const ids = friendships.map(f => String(f.requester) === String(currentUserId) ? f.recipient : f.requester);
  const friends = await User.find({ _id: { $in: ids } }).select("_id username").lean();
  const lower = q.toLocaleLowerCase("en");
  const matches = friends
    .filter(person => {
      const name = String(person.username || "");
      const escaped = name.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^a-z0-9_])" + escaped + "([^a-z0-9_]|$)", "i").test(q);
    })
    .sort((a, b) => lower.indexOf(a.username.toLocaleLowerCase("en")) - lower.indexOf(b.username.toLocaleLowerCase("en")));
  if (matches.length !== 1) return null;

  const friend = matches[0];
  const name = friend.username;
  const index = lower.indexOf(name.toLocaleLowerCase("en"));
  const before = q.slice(0, index).trim();
  const after = q.slice(index + name.length).trim();
  const cleanPlace = value => value
    .replace(/^[\s,;:.-]*(?:(?:how\s+far\s+is|how\s+far|how\s+long\s+is|what\s+is\s+the\s+distance|distance\s+between|distance\s+from|calculate\s+(?:the\s+)?distance|tell\s+me\s+the\s+distance)\s+)?/i, "")
    .replace(/^[\s,;:.-]*(?:from|to|and|of|in)\s+/i, "")
    .replace(/\s+(?:from|to|away|by\s+road|in\s+a\s+straight\s+line)\s*$/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
  const candidate = cleanPlace(before) || cleanPlace(after);
  if (!candidate || /^(me|myself|you|user)$/i.test(candidate)) return null;
  return {
    intent: "distance",
    origin: "friend",
    originPerson: name,
    destination: candidate,
    destinationType: "place"
  };
}

function inferPlaceDistanceIntent(question) {
  const q = String(question || "").trim().replace(/[?.!]+$/g, "");
  if (!/\b(distance|far|apart|kilomet(?:er|re)s?|miles?|how long|travel time|drive|driving)\b/i.test(q)) return null;
  const patterns = [
    /^(.+?)\s+(?:distance|far)\s+from\s+me$/i,
    /^how\s+far\s+is\s+(.+?)\s+from\s+me$/i,
    /^how\s+long\s+does\s+it\s+take\s+from\s+me\s+to\s+(.+)$/i,
    /^distance\s+from\s+me\s+to\s+(.+)$/i,
    /^(?:calculate\s+)?(?:the\s+)?distance\s+between\s+me\s+and\s+(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match && match[1].trim()) return { intent: "distance", origin: "me", destination: match[1].trim(), destinationType: "place" };
  }
  return null;
}

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();

  try {
    // LLM understands the open-ended question; deterministic code then performs
    // authorization, coordinate resolution, Haversine distance, and road routing.
    const parsed = inferPlaceDistanceIntent(question)
      || await inferFriendPlaceDistanceIntent(question, req.user.userId)
      || await inferPersonDistanceIntent(question, req.user.userId)
      || await understandLocationQuestion(question);

    if (parsed?.intent === "distance") {
      const answer = await answerDistanceQuestion(req, parsed);
      if (answer) return res.json({ success: true, answer });
      return res.json({
        success: true,
        answer: "I recognized a distance question, but couldn't confidently identify both endpoints. Please include the two people or the city/place."
      });
    }
  } catch (error) {
    console.error("Location question understanding failed:", error.message);
    // Do not send a distance request to RAG, where it could invent or miss a calculation.
    if (/\\b(distance|far|apart|kilomet(?:er|re)s?|miles?|how long|travel time|drive|driving)\\b/i.test(question)) {
      return res.json({
        success: true,
        answer: "I couldn't reliably interpret that distance question right now. Please try again with both people or a city/place named."
      });
    }
  }

  return askMap(req, res);
};
