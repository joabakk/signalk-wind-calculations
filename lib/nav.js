/*
 * Small navigation helpers. Positions are {latitude, longitude} in
 * degrees; results in Signal K units (rad, m).
 */

const R = 6371000;
const DEG = Math.PI / 180;

// Initial great-circle bearing from a to b, true, 0..2π.
function bearing(a, b) {
  const φ1 = a.latitude * DEG;
  const φ2 = b.latitude * DEG;
  const Δλ = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
}

// Haversine distance in metres.
function distance(a, b) {
  const φ1 = a.latitude * DEG;
  const φ2 = b.latitude * DEG;
  const Δφ = φ2 - φ1;
  const Δλ = (b.longitude - a.longitude) * DEG;
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/*
 * The leg after the current destination of an active route.
 * coordinates are GeoJSON [lon, lat]; pointIndex/reverse as in the Signal K
 * course API (pointIndex counts in the direction of travel).
 * Returns { from, to } positions, or undefined on the last leg.
 */
function nextLeg(coordinates, pointIndex, reverse) {
  const pts = reverse ? [...coordinates].reverse() : coordinates;
  if (!(pointIndex >= 0) || pointIndex + 1 >= pts.length) return undefined;
  const pos = ([longitude, latitude]) => ({ latitude, longitude });
  return { from: pos(pts[pointIndex]), to: pos(pts[pointIndex + 1]) };
}

module.exports = { bearing, distance, nextLeg };
