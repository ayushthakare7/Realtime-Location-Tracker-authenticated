function decodePolyline(encoded) {
  if (typeof encoded !== "string" || !encoded.length) return [];
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    const readValue = () => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        if (index >= encoded.length) throw new Error("Invalid encoded route polyline.");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63 || shift > 30) throw new Error("Invalid encoded route polyline.");
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    };
    latitude += readValue();
    longitude += readValue();
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function calculateRemainingDistanceMeters(encodedPolyline, latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let points;
  try { points = decodePolyline(encodedPolyline); } catch { return null; }
  if (points.length < 2) return null;
  const current = { latitude, longitude };
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const distance = distanceMeters(current, points[i]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  let remaining = 0;
  for (let i = nearestIndex; i < points.length - 1; i++) {
    remaining += distanceMeters(points[i], points[i + 1]);
  }
  return Math.max(0, Math.round(remaining));
}

module.exports = { calculateRemainingDistanceMeters, decodePolyline, distanceMeters };
