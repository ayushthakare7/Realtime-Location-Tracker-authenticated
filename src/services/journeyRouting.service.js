const { geocodePlace } = require("./geocoding.service");
const { getTravelModeById } = require("./travelMode.service");

// Public Valhalla demonstration endpoint. It requires no API key and is intended
// for modest project/testing traffic; it is not an uptime or production SLA.
const VALHALLA_ROUTE_URL = process.env.VALHALLA_ROUTE_URL || "https://valhalla1.openstreetmap.de/route";
const VALHALLA_COSTING = Object.freeze({
  walking: "pedestrian",
  running: "pedestrian",
  skateboard: "pedestrian",
  roller_skates: "pedestrian",
  wheelchair: "pedestrian",
  bicycle: "bicycle",
  kick_scooter: "bicycle",
  car: "auto",
  motorcycle: "auto",
  scooter: "auto",
  auto_rickshaw: "auto"
});

function parseDurationSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

function supportedTravelMode(modeId) {
  return Boolean(VALHALLA_COSTING[modeId]);
}

function decodePolyline(encoded, precision = 6) {
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const factor = 10 ** precision;
  while (index < encoded.length) {
    const readValue = () => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        if (index >= encoded.length) throw new Error("Invalid encoded route shape.");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63 || shift > 30) throw new Error("Invalid encoded route shape.");
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    };
    latitude += readValue();
    longitude += readValue();
    points.push({ latitude: latitude / factor, longitude: longitude / factor });
  }
  return points;
}

function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let previousLatitude = 0;
  let previousLongitude = 0;
  let output = "";
  const encodeValue = value => {
    let encoded = value < 0 ? ~(value << 1) : (value << 1);
    let chunk = "";
    while (encoded >= 0x20) {
      chunk += String.fromCharCode((0x20 | (encoded & 0x1f)) + 63);
      encoded >>= 5;
    }
    chunk += String.fromCharCode(encoded + 63);
    return chunk;
  };
  for (const point of points) {
    const latitude = Math.round(point.latitude * factor);
    const longitude = Math.round(point.longitude * factor);
    output += encodeValue(latitude - previousLatitude);
    output += encodeValue(longitude - previousLongitude);
    previousLatitude = latitude;
    previousLongitude = longitude;
  }
  return output;
}

function convertPolyline6To5(encoded) {
  const points = decodePolyline(encoded, 6);
  if (points.length < 2) throw new Error("Routing provider returned an incomplete route shape.");
  return encodePolyline(points, 5);
}

async function fetchValhallaRoute({ origin, destination, modeId }) {
  const costing = VALHALLA_COSTING[modeId];
  if (!costing) {
    const error = new Error("Free routing is not available for " + (getTravelModeById(modeId)?.label || modeId) + " yet. Live journey tracking can still be used when a supported route is available.");
    error.code = "ROUTING_MODE_UNSUPPORTED";
    throw error;
  }

  let response;
  try {
    response = await fetch(VALHALLA_ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "RevaSafetyTravel/1.0 (open-source project)" },
      body: JSON.stringify({
        locations: [
          { lat: origin.latitude, lon: origin.longitude },
          { lat: destination.latitude, lon: destination.longitude }
        ],
        costing,
        units: "kilometers",
        shape_format: "polyline6",
        directions_options: { units: "kilometers" }
      }),
      signal: AbortSignal.timeout(12000)
    });
  } catch (cause) {
    const error = new Error("The free OpenStreetMap routing service is temporarily unreachable. Try again when you are online.");
    error.code = "ROUTING_PROVIDER_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("The free routing service returned HTTP " + response.status + ". Please retry later.");
    error.code = response.status === 429 || response.status >= 500 ? "ROUTING_PROVIDER_UNAVAILABLE" : "ROUTING_PROVIDER_ERROR";
    throw error;
  }

  const data = await response.json();
  const trip = data.trip;
  const leg = trip?.legs?.[0];
  const summary = trip?.summary;
  const distanceKm = Number(summary?.length);
  const durationSeconds = parseDurationSeconds(summary?.time);
  if (!leg?.shape || !Number.isFinite(distanceKm) || distanceKm <= 0 || durationSeconds === null) {
    const error = new Error(data.error || "No route was found for these places and travel mode.");
    error.code = "NO_ROUTE_FOUND";
    throw error;
  }

  return [{
    optionId: "osm-route-0",
    provider: "valhalla-openstreetmap",
    providerRouteId: null,
    distanceMeters: Math.round(distanceKm * 1000),
    durationSeconds,
    encodedPolyline: convertPolyline6To5(leg.shape),
    routeLabels: ["OpenStreetMap route"]
  }];
}

async function resolveAndRoute({ originText, destinationText, modeId, currentOrigin = null }) {
  const mode = getTravelModeById(modeId);
  if (!mode) {
    const error = new Error("Select a supported travel mode.");
    error.code = "INVALID_TRAVEL_MODE";
    throw error;
  }
  if (!supportedTravelMode(modeId)) {
    const error = new Error("Free route calculation is not available for " + mode.label + " yet. Reva will not invent a route.");
    error.code = "ROUTING_MODE_UNSUPPORTED";
    throw error;
  }

  const originIsCurrentLocation = /^(my )?(current location|current position|here|my location)$/i.test(String(originText || "").trim());
  const [resolvedOrigin, destination] = await Promise.all([
    originIsCurrentLocation && currentOrigin
      ? Promise.resolve({
          latitude: Number(currentOrigin.latitude),
          longitude: Number(currentOrigin.longitude),
          name: "Current location",
          state: null,
          country: null
        })
      : geocodePlace(originText),
    geocodePlace(destinationText)
  ]);
  const origin = resolvedOrigin;
  if (!origin) {
    const error = new Error("Could not resolve the origin. Add a more specific place name.");
    error.code = "ORIGIN_UNRESOLVED";
    throw error;
  }
  if (!destination) {
    const error = new Error("Could not resolve the destination. Add a more specific place name.");
    error.code = "DESTINATION_UNRESOLVED";
    throw error;
  }
  if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) {
    const error = new Error("Origin and destination resolve to the same coordinates. Please clarify the destination.");
    error.code = "SAME_ENDPOINT";
    throw error;
  }
  const routes = await fetchValhallaRoute({ origin, destination, modeId });
  return {
    origin: { latitude: origin.latitude, longitude: origin.longitude, label: [origin.name, origin.state, origin.country].filter(Boolean).join(", ") },
    destination: { latitude: destination.latitude, longitude: destination.longitude, label: [destination.name, destination.state, destination.country].filter(Boolean).join(", ") },
    routes
  };
}

module.exports = {
  convertPolyline6To5,
  decodePolyline,
  encodePolyline,
  fetchValhallaRoute,
  parseDurationSeconds,
  resolveAndRoute,
  supportedTravelMode
};
