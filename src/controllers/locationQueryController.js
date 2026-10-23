const Location = require("../models/Location");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { askMap } = require("./trackerController");
const { understandLocationQuestion } = require("../services/gemini.service");

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeCity(city) {
  const place = String(city || "").trim();
  if (!place) {
    console.warn("[Geocoding] Empty destination received.");
    return null;
  }

  if (process.env.GEOCODING_ENABLED !== "true") {
    console.warn(
      "[Geocoding] Disabled. Set GEOCODING_ENABLED=true in the runtime environment and restart/redeploy."
    );
    return null;
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("q", `${place}, India`);
    url.searchParams.set("countrycodes", "in");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "PrivacyAwareLocationTracker/1.0 (city geocoding)"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.error(
        "[Geocoding] Nominatim returned HTTP",
        response.status,
        response.statusText
      );
      return null;
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      console.warn("[Geocoding] No India results for destination:", place);
      return null;
    }

    // Prefer a city/town/municipality match when Nominatim returns several results.
    const normalizedPlace = place.toLocaleLowerCase("en-IN");
    const result = results.find(item => {
      const address = item.address || {};
      const names = [
        address.city,
        address.town,
        address.municipality,
        address.village,
        item.name,
        item.display_name?.split(",")[0]
      ].filter(Boolean).map(value => String(value).toLocaleLowerCase("en-IN"));
      return names.includes(normalizedPlace);
    }) || results[0];

    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      console.error("[Geocoding] Invalid coordinates returned for:", place);
      return null;
    }

    const address = result.address || {};
    const resolvedName =
      address.city ||
      address.town ||
      address.municipality ||
      address.village ||
      result.name ||
      place;

    console.info(
      "[Geocoding] Resolved destination:",
      place,
      "->",
      resolvedName,
      latitude,
      longitude
    );

    return {
      latitude,
      longitude,
      name: resolvedName,
      state: address.state || null,
      country: address.country || "India"
    };
  } catch (error) {
    console.error(
      "[Geocoding] Request failed for",
      place,
      "-",
      error.message
    );
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
    if (!destination) return `I couldn't resolve ${parsed.destination} to a location in India.`;
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

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();

  try {
    // LLM understands the open-ended question; deterministic code then performs
    // authorization, coordinate resolution, Haversine distance, and road routing.
    const parsed = await understandLocationQuestion(question);

    if (parsed?.intent === "distance") {
      const answer = await answerDistanceQuestion(req, parsed);
      if (answer) return res.json({ success: true, answer });
    }
  } catch (error) {
    // If query understanding fails, keep the existing RAG/history assistant available.
    console.error("Location question understanding failed:", error.message);
  }

  return askMap(req, res);
};
