/*
 * Laylines to the next mark.
 *
 * Works in a flat east/north frame (metres) centred on the boat, fine over
 * the few miles of a race leg. On each tack (or gybe) the boat is assumed
 * to sail at the target TWA and speed, with current added, so each tack
 * has a ground track direction. The layline the boat is sailing towards
 * is the line into the mark along the *other* tack's ground track: the
 * boat tacks onto it and fetches the mark. The opposite layline is where
 * it would end up after tacking now.
 *
 * Distances are measured along the boat's own ground track; negative
 * means the layline is already behind (overstood). Undefined when the
 * mark can be laid without tacking, or isn't upwind (or downwind) at all.
 */

const R = 6371000;
const DEG = Math.PI / 180;

function offset(from, to) {
  const lat0 = ((from.latitude + to.latitude) / 2) * DEG;
  return {
    e: (to.longitude - from.longitude) * DEG * R * Math.cos(lat0),
    n: (to.latitude - from.latitude) * DEG * R
  };
}

// Ground velocity on the tack with side s (+1 = starboard).
function trackVelocity(twd, angle, speed, s, current) {
  const heading = twd - s * angle;
  return {
    e: speed * Math.sin(heading) + (current ? current.e : 0),
    n: speed * Math.cos(heading) + (current ? current.n : 0)
  };
}

// Distance along u to where the ray from the origin meets the line into
// mark along v (approaching the mark, i.e. at mark - k·v with k >= 0).
function along(u, v, mark) {
  const lu = Math.hypot(u.e, u.n);
  const lv = Math.hypot(v.e, v.n);
  if (lu < 1e-6 || lv < 1e-6) return undefined;
  const a = { e: u.e / lu, n: u.n / lu };
  const b = { e: v.e / lv, n: v.n / lv };
  // t·a + k·b = mark
  const det = a.e * b.n - a.n * b.e;
  if (Math.abs(det) < 1e-6) return undefined;
  const t = (mark.e * b.n - mark.n * b.e) / det;
  const k = (a.e * mark.n - a.n * mark.e) / det;
  return k >= 0 ? t : undefined;
}

/*
 * boat, mark: {latitude, longitude}. twd: rad. angle: target TWA for this
 * point of sail, positive (beat angle upwind, gybe angle downwind).
 * speed: target boat speed (m/s). side: current tack, +1 starboard / -1
 * port. current: optional east/north vector (m/s).
 * Returns { layline: {distance, speed}, opposite: {distance, speed} } with
 * either entry undefined when it doesn't apply.
 */
function laylines({ boat, mark, twd, angle, speed, side, current }) {
  const m = offset(boat, mark);
  const upwind = angle < Math.PI / 2;
  // The mark has to be on the right side of the boat for this point of sail
  const towardWind = m.e * Math.sin(twd) + m.n * Math.cos(twd);
  if (upwind ? towardWind <= 0 : towardWind >= 0) return { layline: undefined, opposite: undefined };

  const own = trackVelocity(twd, angle, speed, side, current);
  const other = trackVelocity(twd, angle, speed, -side, current);
  const result = (u, v) => {
    const d = along(u, v, m);
    return d === undefined ? undefined : { distance: d, speed: Math.hypot(u.e, u.n) };
  };
  return { layline: result(own, other), opposite: result(other, own) };
}

module.exports = { laylines };
