const Location = require("../models/Location");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { askMap } = require("./trackerController");

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractCityDistanceTarget(question) {
  const match = String(question || "").match(/\b(?:how\s+many\s*(?:km|kilometers?|kilometres?|miles?)|how\s+far|distance)\s+(?:is\s+)?(.+?)\s+(?:away\s+from\s+me|from\s+me|away)\b/i);
  if (!match) return null;
  const target = match[1]
    .replace(/^is\s+/i, "")
    .replace(/\b(?:the|city)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!target || target.length > 80) return null;
  return target;
}

function extractCityDistanceFromFriend(question) {
  const match = String(question || "").match(/\bhow\s+far\s+is\s+(.+?)\s+from\s+(?:my\s+)?friend\s+([a-z0-9_]+)\b/i);
  if (!match) return null;
  const city = match[1]
    .replace(/\b(?:the|city)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const username = match[2].trim();
  if (!city || city.length > 80 || !username) return null;
  return { city, username };
}

async function geocodeCity(city) {
  if (process.env.GEOCODING_ENABLED !== "true") return null;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", `${city}, India`);
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  const response = await fetch(url, {
    headers: { "User-Agent": "PrivacyAwareLocationTracker/1.0" },
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return null;
  const results = await response.json();
  if (!Array.isArray(results) || !results.length) return null;
  const result = results[0];
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    latitude: lat,
    longitude: lon,
    name: result.address?.city || result.address?.town || result.address?.municipality || city,
    state: result.address?.state || null,
    country: result.address?.country || "India"
  };
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
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(data.code || "No route found");
  }

  const route = data.routes[0];
  return {
    distanceKm: Number(route.distance) / 1000,
    durationMinutes: Number(route.duration) / 60
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

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();
  const cityFromFriend = extractCityDistanceFromFriend(question);
  const targetCity = extractCityDistanceTarget(question);

  if (cityFromFriend) {
    try {
      const friend = await User.findOne({ username: cityFromFriend.username }).select("_id username sharingEnabled").lean();
      if (!friend) {
        return res.json({ success: true, answer: `I couldn't find a user named ${cityFromFriend.username}.` });
      }

      const friendship = await Friendship.findOne({
        status: "accepted",
        $or: [
          { requester: req.user.userId, recipient: friend._id },
          { requester: friend._id, recipient: req.user.userId }
        ]
      }).lean();

      if (!friendship) {
        return res.json({ success: true, answer: `I can only calculate distances involving your accepted friends. ${friend.username} is not an accepted friend.` });
      }

      if (!friend.sharingEnabled) {
        return res.json({ success: true, answer: `${friend.username} is not currently sharing their location.` });
      }

      const friendLocation = await Location.findOne({ userId: friend._id }).lean();
      if (!friendLocation) {
        return res.json({ success: true, answer: `I don't have a latest shared location for ${friend.username}.` });
      }

      const destination = await geocodeCity(cityFromFriend.city);
      if (!destination) {
        return res.json({ success: true, answer: `I couldn't resolve ${cityFromFriend.city} to a location in India.` });
      }

      const straightLineKm = distanceKm(friendLocation.latitude, friendLocation.longitude, destination.latitude, destination.longitude);

      try {
        const route = await getRoadRoute(friendLocation.latitude, friendLocation.longitude, destination.latitude, destination.longitude);
        const displayName = destination.name || cityFromFriend.city;
        const state = destination.state ? `, ${destination.state}` : "";
        return res.json({
          success: true,
          answer: `${displayName}${state} is approximately ${route.distanceKm.toFixed(1)} km away from ${friend.username} by road. Estimated driving time is about ${formatDuration(route.durationMinutes)}. Straight-line distance is ${straightLineKm.toFixed(1)} km.`
        });
      } catch (routeError) {
        console.error("Road routing from friend failed:", routeError.message);
        const displayName = destination.name || cityFromFriend.city;
        const state = destination.state ? `, ${destination.state}` : "";
        return res.json({
          success: true,
          answer: `${displayName}${state} is approximately ${straightLineKm.toFixed(2)} km from ${friend.username} in a straight line. I couldn't get a road route right now.`
        });
      }
    } catch (error) {
      console.error("City-from-friend distance query failed:", error.message);
      return askMap(req, res);
    }
  }

  if (!targetCity) return askMap(req, res);

  try {
    const mine = await Location.findOne({ userId: req.user.userId }).lean();
    if (!mine) {
      return res.json({
        success: true,
        answer: "I need your latest location first. Turn on location sharing and allow location access, then ask me again."
      });
    }

    const destination = await geocodeCity(targetCity);
    if (!destination) return askMap(req, res);

    const straightLineKm = distanceKm(mine.latitude, mine.longitude, destination.latitude, destination.longitude);

    try {
      const route = await getRoadRoute(
        mine.latitude,
        mine.longitude,
        destination.latitude,
        destination.longitude
      );

      const displayName = destination.name || targetCity;
      const state = destination.state ? `, ${destination.state}` : "";

      return res.json({
        success: true,
        answer: `${displayName}${state} is approximately ${route.distanceKm.toFixed(1)} km away by road. Estimated driving time is about ${formatDuration(route.durationMinutes)}. Straight-line distance is ${straightLineKm.toFixed(1)} km. Route distance is based on the fastest driving route available from OpenStreetMap road data.`
      });
    } catch (routeError) {
      console.error("Road routing failed:", routeError.message);

      const meters = Math.round(straightLineKm * 1000);
      const displayName = destination.name || targetCity;
      const state = destination.state ? `, ${destination.state}` : "";

      return res.json({
        success: true,
        answer: `${displayName}${state} is approximately ${meters.toLocaleString("en-IN")} metres (${straightLineKm.toFixed(2)} km) from your current location in a straight line. I couldn't get a road route right now, so this is geographic distance rather than driving distance.`
      });
    }
  } catch (error) {
    console.error("City distance query failed:", error.message);
    return askMap(req, res);
  }
};
