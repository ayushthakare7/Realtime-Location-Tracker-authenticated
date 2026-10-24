const ROUTE_URL = process.env.VALHALLA_ROUTE_URL || "https://valhalla1.openstreetmap.de/route";
const COSTING = Object.freeze({
  walking: "pedestrian", running: "pedestrian", wheelchair: "pedestrian",
  skateboard: "pedestrian", roller_skates: "pedestrian",
  bicycle: "bicycle", kick_scooter: "bicycle",
  car: "auto", motorcycle: "auto", scooter: "auto", auto_rickshaw: "auto"
});

function validatePoint(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number(point.latitude) >= -90 &&
    Number(point.latitude) <= 90 && Number.isFinite(Number(point.longitude)) &&
    Number(point.longitude) >= -180 && Number(point.longitude) <= 180;
}
function decodePolyline(encoded, precision = 6) {
  let index = 0, lat = 0, lon = 0;
  const points = [], factor = 10 ** precision;
  while (index < encoded.length) {
    const read = () => {
      let result = 0, shift = 0, byte;
      do {
        if (index >= encoded.length) throw new Error("Invalid route geometry.");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63 || shift > 30) throw new Error("Invalid route geometry.");
        result |= (byte & 31) << shift; shift += 5;
      } while (byte >= 32);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    lat += read(); lon += read();
    points.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return points;
}
function encodePolyline(points, precision = 5) {
  let lastLat = 0, lastLon = 0, output = "";
  const factor = 10 ** precision;
  const encode = value => {
    let n = value < 0 ? ~(value << 1) : value << 1, s = "";
    while (n >= 32) { s += String.fromCharCode((32 | (n & 31)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.latitude * factor), lon = Math.round(p.longitude * factor);
    output += encode(lat - lastLat) + encode(lon - lastLon); lastLat = lat; lastLon = lon;
  }
  return output;
}
async function calculateRoute({ origin, destination, modeId }) {
  if (!validatePoint(origin) || !validatePoint(destination)) {
    const error = new Error("Valid origin and destination coordinates are required."); error.status = 400; throw error;
  }
  const costing = COSTING[modeId];
  if (!costing) { const error = new Error("No free route profile is configured for this travel mode."); error.status = 422; throw error; }
  let response;
  try {
    response = await fetch(ROUTE_URL, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "RevaSafetyTravel/1.0 (open-source project)" },
      body: JSON.stringify({
        locations: [{ lat: Number(origin.latitude), lon: Number(origin.longitude) }, { lat: Number(destination.latitude), lon: Number(destination.longitude) }],
        costing, units: "kilometers", shape_format: "polyline6", directions_options: { units: "kilometers" }
      }),
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    const error = new Error("The public OpenStreetMap routing endpoint is temporarily unavailable. Please retry."); error.status = 503; throw error;
  }
  if (!response.ok) {
    const error = new Error("Routing provider returned HTTP " + response.status + ". Please retry later.");
    error.status = response.status === 429 || response.status >= 500 ? 503 : 502; throw error;
  }
  const data = await response.json(), trip = data.trip, leg = trip?.legs?.[0], summary = trip?.summary;
  const km = Number(summary?.length), seconds = Number(summary?.time);
  if (!leg?.shape || !Number.isFinite(km) || km <= 0 || !Number.isFinite(seconds) || seconds < 0) {
    const error = new Error(data.error || "No route found for these coordinates."); error.status = 404; throw error;
  }
  const points = decodePolyline(leg.shape, 6);
  if (points.length < 2) { const error = new Error("Routing provider returned incomplete geometry."); error.status = 502; throw error; }
  return {
    provider: "valhalla-openstreetmap", distanceMeters: Math.round(km * 1000),
    durationSeconds: Math.round(seconds), encodedPolyline: encodePolyline(points, 5),
    routeLabels: ["OpenStreetMap route"]
  };
}
module.exports = { calculateRoute, validatePoint };
