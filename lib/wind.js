/*
 * Pure wind math. Everything is in Signal K base units: m/s and radians.
 *
 * Conventions:
 *  - Relative angles (AWA, TWA, ...) are -π..π, 0 = on the bow,
 *    positive = wind coming over starboard.
 *  - Absolute directions (TWD, ...) are 0..2π, the direction the wind
 *    blows FROM.
 *  - Wind vectors here are "from" vectors in the boat frame:
 *    x = forward, y = starboard.
 */

const TWO_PI = 2 * Math.PI;
const EPS = 1e-9;

// -π..π
function normRelative(a) {
  a = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
  return a - Math.PI;
}

// 0..2π
function normDirection(a) {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/*
 * Subtracts the boat's own motion from the apparent wind.
 *   aws, awa     apparent wind speed / angle
 *   boatSpeed    STW (for true wind) or SOG (for ground wind)
 *   motionAngle  direction the boat is moving relative to the bow:
 *                leeway for true wind, COG - heading for ground wind
 */
function windFromApparent(aws, awa, boatSpeed, motionAngle = 0) {
  const x = aws * Math.cos(awa) - boatSpeed * Math.cos(motionAngle);
  const y = aws * Math.sin(awa) - boatSpeed * Math.sin(motionAngle);
  const speed = Math.hypot(x, y);
  return { speed, angle: speed < EPS ? 0 : Math.atan2(y, x) };
}

/*
 * A heeled masthead sensor only sees the cross-boat component of the wind
 * scaled by cos(heel). Undo that to get the horizontal apparent wind.
 */
function heelCorrect(aws, awa, heel) {
  const c = Math.cos(heel);
  const x = aws * Math.cos(awa);
  const y = (aws * Math.sin(awa)) / c;
  return { speed: Math.hypot(x, y), angle: Math.atan2(y, x) };
}

/*
 * Power-law wind profile: scales a wind speed measured at fromHeight to
 * toHeight. An exponent of ~0.11 is typical over open water.
 */
function speedAtHeight(speed, fromHeight, toHeight = 10, exponent = 0.11) {
  return speed * Math.pow(toHeight / fromHeight, exponent);
}

// VMG along the wind axis, positive when making ground upwind.
function velocityMadeGood(boatSpeed, twa) {
  return boatSpeed * Math.cos(twa);
}

/*
 * Earth-frame velocity vectors: east/north components of a speed along a
 * true direction, and back.
 */
function toEN(speed, direction) {
  return { e: speed * Math.sin(direction), n: speed * Math.cos(direction) };
}

function fromEN(v) {
  const speed = Math.hypot(v.e, v.n);
  return { speed, direction: speed < EPS ? 0 : normDirection(Math.atan2(v.e, v.n)) };
}

/*
 * Tidal/ocean current as the difference between motion over ground and
 * motion through the water. Only meaningful with a real compass heading:
 * with COG standing in for heading it is zero by construction.
 * Returns east/north components so callers can smooth them.
 */
function currentVector(heading, stw, leeway, cog, sog) {
  const water = toEN(stw, heading + leeway);
  const ground = toEN(sog, cog);
  return { e: ground.e - water.e, n: ground.n - water.n };
}

/*
 * Heading and course over ground after tacking (or gybing), assuming the
 * same TWA, speed and leeway mirrored onto the other side of the wind.
 * current is an optional east/north vector.
 */
function oppositeTack(twd, heading, stw, leeway, current) {
  const oppHeading = normDirection(2 * twd - heading);
  const water = toEN(stw, oppHeading - leeway);
  const e = water.e + (current ? current.e : 0);
  const n = water.n + (current ? current.n : 0);
  return { heading: oppHeading, cog: fromEN({ e, n }).direction };
}

/*
 * How much a wind shift helps on the current tack. phase is the shift of
 * TWD from its average, positive = veer (clockwise). Positive lift means
 * the boat can steer closer to a mark straight up/down wind: upwind, a
 * veer lifts on starboard tack; downwind, a veer heads on starboard.
 */
function windLift(phase, twa) {
  return phase * Math.sign(twa) * (Math.cos(twa) >= 0 ? 1 : -1);
}

/*
 * Start line bias: how much further upwind one end of the line is.
 * Ends are {latitude, longitude}; twd is where the wind blows from.
 * Returns the distance in metres (positive = starboard end, i.e. the end
 * on the right when looking upwind, is favoured).
 */
function startLineBias(endA, endB, twd) {
  const R = 6371000;
  const lat0 = ((endA.latitude + endB.latitude) / 2) * Math.PI / 180;
  const dE = (endB.longitude - endA.longitude) * Math.PI / 180 * R * Math.cos(lat0);
  const dN = (endB.latitude - endA.latitude) * Math.PI / 180 * R;
  const upwind = dE * Math.sin(twd) + dN * Math.cos(twd);
  const right = dE * Math.cos(twd) - dN * Math.sin(twd);
  // upwind is B relative to A; flip it if A is the starboard end
  return right >= 0 ? upwind : -upwind;
}

/*
 * Exponential smoothing with a time constant (seconds). Speeds are
 * smoothed as scalars; angles through their unit vector so wrapping
 * through ±π / 0 doesn't drag the average the wrong way round.
 */
class SpeedFilter {
  constructor(tau) {
    this.tau = tau;
    this.value = undefined;
  }

  update(v, dt) {
    if (this.value === undefined || !(this.tau > 0)) {
      this.value = v;
    } else {
      const k = 1 - Math.exp(-dt / this.tau);
      this.value += k * (v - this.value);
    }
    return this.value;
  }
}

class AngleFilter {
  constructor(tau) {
    this.tau = tau;
    this.c = undefined;
    this.s = undefined;
  }

  update(a, dt) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    if (this.c === undefined || !(this.tau > 0)) {
      this.c = c;
      this.s = s;
    } else {
      const k = 1 - Math.exp(-dt / this.tau);
      this.c += k * (c - this.c);
      this.s += k * (s - this.s);
    }
    return Math.atan2(this.s, this.c);
  }
}

/*
 * Rolling window of true wind samples for average/gust/lull and mean
 * direction.
 */
class WindowStats {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  push(t, speed, direction) {
    this.samples.push({ t, speed, direction });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  summary() {
    const n = this.samples.length;
    if (!n) return undefined;
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let c = 0;
    let s = 0;
    let haveDirection = false;
    for (const x of this.samples) {
      sum += x.speed;
      if (x.speed > max) max = x.speed;
      if (x.speed < min) min = x.speed;
      if (x.direction !== undefined) {
        c += Math.cos(x.direction);
        s += Math.sin(x.direction);
        haveDirection = true;
      }
    }
    const result = { speedAverage: sum / n, speedMax: max, speedMin: min };
    if (haveDirection) {
      result.directionAverage = normDirection(Math.atan2(s, c));
    }
    return result;
  }
}

module.exports = {
  normRelative,
  normDirection,
  windFromApparent,
  heelCorrect,
  speedAtHeight,
  velocityMadeGood,
  toEN,
  fromEN,
  currentVector,
  oppositeTack,
  windLift,
  startLineBias,
  SpeedFilter,
  AngleFilter,
  WindowStats
};
