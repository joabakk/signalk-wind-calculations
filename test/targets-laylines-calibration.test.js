const test = require('node:test');
const assert = require('node:assert');
const wind = require('../lib/wind');
const { TackDetector, gybeView } = require('../lib/tack');
const { laylines } = require('../lib/layline');

const DEG = Math.PI / 180;
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

test('apparent from true is the inverse of true from apparent', () => {
  const a = wind.apparentFromTrue(6, -42 * DEG, 3.2);
  const t = wind.windFromApparent(a.speed, a.angle, 3.2);
  close(t.speed, 6);
  close(t.angle, -42 * DEG);
  assert.ok(Math.abs(a.angle) < 42 * DEG, 'apparent is forward of true');
});

// 1 Hz, instant manoeuvre at 60 s. twaTrue is the real TWA on starboard;
// the instrument reads it widened by err. TWD is from 000 throughout.
function sailWithError(detector, { twaTrue, err, view = (x) => x, sign = 1 }) {
  const results = [];
  for (let s = 0; s <= 120; s++) {
    const stb = s < 60;
    const real = stb ? twaTrue : -twaTrue;
    const measured = stb ? twaTrue + err : -(twaTrue + err);
    const heading = -real; // TWD 0 = heading + real TWA
    const twd = wind.normDirection(heading + measured);
    const vmg = 3 * Math.cos(measured) * sign;
    const r = detector.update(s * 1000, view(measured), vmg, undefined, twd);
    if (r) results.push(r);
  }
  return results;
}

test('TWA reading too wide shows as a TWD jump across a tack', () => {
  const r = sailWithError(new TackDetector(), { twaTrue: 40 * DEG, err: 3 * DEG });
  assert.strictEqual(r.length, 1);
  close(r[0].twdBefore, 3 * DEG);
  close(r[0].twdAfter, wind.normDirection(-3 * DEG));
  close(r[0].twdDifference, -6 * DEG);
  close(r[0].angleError, 3 * DEG);
});

test('TWA reading too narrow gives a negative error, either tack first', () => {
  const r = sailWithError(new TackDetector(), { twaTrue: -40 * DEG, err: 2 * DEG });
  // starts on port (TWA -40 reads -38): narrow by 2°
  close(r[0].angleError, -2 * DEG);
});

test('no TWD fields without TWD', () => {
  const d = new TackDetector();
  let r;
  for (let s = 0; s <= 120; s++) r = d.update(s * 1000, (s < 60 ? 40 : -40) * DEG, 2) || r;
  assert.strictEqual(r.twdDifference, undefined);
  assert.strictEqual(r.angleError, undefined);
});

test('gybes through the gybe view: loss, angle and calibration', () => {
  const r = sailWithError(new TackDetector(), { twaTrue: 150 * DEG, err: 2 * DEG, view: gybeView, sign: -1 });
  assert.strictEqual(r.length, 1);
  close(r[0].angle, 56 * DEG); // 2 × (180 - 152)
  close(r[0].performance, 1, 1e-9);
  close(r[0].angleError, 2 * DEG);
});

test('gybe view ignores tacks and tack detector ignores gybes', () => {
  const tacks = new TackDetector();
  const gybes = new TackDetector();
  let tackResults = 0;
  let gybeResults = 0;
  for (let s = 0; s <= 240; s++) {
    // tack at 60 s, then bear away and gybe at 180 s
    const twa = (s < 60 ? 40 : s < 120 ? -40 : s < 180 ? -150 : 150) * DEG;
    if (tacks.update(s * 1000, twa, 3 * Math.cos(twa))) tackResults++;
    if (gybes.update(s * 1000, gybeView(twa), -3 * Math.cos(twa))) gybeResults++;
  }
  assert.strictEqual(tackResults, 1);
  assert.strictEqual(gybeResults, 1);
});

// Positions east/north of a reference point, metres
const origin = { latitude: 59, longitude: 10.9 };
const at = (e, n) => ({
  latitude: origin.latitude + n / (6371000 * DEG),
  longitude: origin.longitude + e / (6371000 * DEG * Math.cos((59 + n / 2 / 111195) * DEG))
});

test('laylines upwind: distances along the ground track', () => {
  // Wind from 000, 45° beat, starboard tack (heading 315), mark 200 E 1000 N
  const l = laylines({ boat: origin, mark: at(200, 1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1 });
  close(l.layline.distance, 400 * Math.SQRT2, 0.5);
  close(l.opposite.distance, 600 * Math.SQRT2, 0.5);
  close(l.layline.speed, 3);
});

test('laylines: overstood is negative, layable is undefined', () => {
  const over = laylines({ boat: origin, mark: at(1500, 1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1 });
  close(over.layline.distance, -250 * Math.SQRT2, 0.5);
  const lay = laylines({ boat: origin, mark: at(-2000, 1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1 });
  assert.strictEqual(lay.layline, undefined);
});

test('laylines downwind and mark on the wrong side', () => {
  // Gybe angle 150°, mark 1 km dead downwind, symmetric
  const d = laylines({ boat: origin, mark: at(0, -1000), twd: 0, angle: 150 * DEG, speed: 4, side: 1 });
  close(d.layline.distance, 1000 / (2 * Math.cos(30 * DEG)), 0.5);
  close(d.opposite.distance, d.layline.distance, 0.5);
  const wrong = laylines({ boat: origin, mark: at(0, -1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1 });
  assert.strictEqual(wrong.layline, undefined);
  assert.strictEqual(wrong.opposite, undefined);
});

test('laylines with current: set pushes the tracks', () => {
  // 1 m/s current setting east widens the starboard (NW) track's angle to the mark
  const still = laylines({ boat: origin, mark: at(0, 1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1 });
  const tide = laylines({ boat: origin, mark: at(0, 1000), twd: 0, angle: 45 * DEG, speed: 3, side: 1, current: { e: 1, n: 0 } });
  assert.ok(tide.layline.distance > still.layline.distance, 'longer on the tack the tide sets against');
  assert.ok(tide.opposite.distance < still.opposite.distance);
});
