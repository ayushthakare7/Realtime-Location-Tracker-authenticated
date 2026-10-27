// Pure query classification and nearby-place answer formatting helpers.
function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCurrentQuestion(question) {
  return /\b(right now|currently|current location|current place|where is\s+[^?!.]+|where's\s+[^?!.]+|where\s+[^?!.]+\s+(?:is|are)\b)/i.test(question)
    && !/\b(where was|where were|used to be|last seen|yesterday|last night|last week|last month|days? ago|weeks? ago|last year)\b/i.test(question);
}
function isOwnCurrentQuestion(question) { return /\b(where am i|where i'm|where i am|my current location|my current place|where is my location|where is me)\b/i.test(question); }
function isGeoAddressQuestion(question) { return /\b(which city|what city|which state|what state|which country|what country|city.*state.*country|state.*country|country.*city|city and state|city and country|state and country|in which city|in what city)\b/i.test(question); }
function requestedUsername(question, usernames) { const lower = question.toLowerCase(); return usernames.find(name => lower.includes(String(name).toLowerCase())); }
function isFallbackPlace(place) { return !place || /^Location near -?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/i.test(String(place).trim()); }

function describeNearbyLocation(geo = {}, nearby = [], fallbackPlace = null) {
  const named = nearby.filter(item => item && item.name && Number.isFinite(Number(item.distanceKm)));
  const institutions = named.filter(item => ["university", "college", "hospital", "station", "school"].includes(item.category));
  // Prefer a meaningful institution only when it is genuinely close; otherwise
  // choose a close named POI. Never state that someone is inside a campus based
  // only on a distant map centroid.
  const institution = institutions.find(item => item.distanceKm <= 0.4)
    || institutions.find(item => item.distanceKm <= 1.2);
  const closestPoi = named.find(item => item.category !== "road" && item.distanceKm <= 0.3);
  const landmark = institution || closestPoi || null;
  const road = geo.road || named.find(item => item.category === "road" && item.distanceKm <= 0.2)?.name || null;
  const fallback = !isFallbackPlace(fallbackPlace) ? String(fallbackPlace).trim() : null;
  const knownRegions = [geo.road, geo.locality, geo.city, geo.state, geo.country].filter(Boolean).map(value => String(value).trim().toLocaleLowerCase("en-IN"));
  const fallbackParts = fallback ? fallback.split(",").map(value => value.trim().toLocaleLowerCase("en-IN")).filter(Boolean) : [];
  const fallbackIsRegion = fallbackParts.length > 0 && fallbackParts.every(value => knownRegions.includes(value));
  const landmarkName = landmark?.name || (fallback && !fallbackIsRegion && !knownRegions.includes(fallback.toLocaleLowerCase("en-IN")) ? fallback : null);
  const hierarchy = [];
  for (const value of [geo.locality, geo.city, geo.state, geo.country]) {
    if (value && !hierarchy.some(existing => existing.toLocaleLowerCase("en-IN") === String(value).toLocaleLowerCase("en-IN"))) {
      hierarchy.push(String(value));
    }
  }
  const parts = [];
  if (road) parts.push("Road: " + road);
  if (landmarkName) {
    const distance = Number(landmark?.distanceKm);
    const status = Number.isFinite(distance) && distance <= 0.25 ? "At or very near " : "Near ";
    parts.push(status + landmarkName + (Number.isFinite(distance) ? " (" + (distance * 1000 < 1000 ? Math.round(distance * 1000) + " m" : distance.toFixed(2) + " km") + " away" + ")" : ""));
  }
  parts.push(...hierarchy);
  if (!parts.length && fallback) parts.push(fallback);
  return {
    label: parts.join(", "),
    landmark: landmarkName,
    road,
    distanceKm: landmark && Number.isFinite(Number(landmark.distanceKm)) ? Number(landmark.distanceKm) : null,
    source: landmark?.source || (road ? "reverse-geocoder/map data" : null)
  };
}

module.exports = { isCurrentQuestion, isOwnCurrentQuestion, isGeoAddressQuestion, requestedUsername, isFallbackPlace, describeNearbyLocation };
