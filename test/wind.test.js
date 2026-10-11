const test = require('node:test');
const assert = require('node:assert');
const wind = require('../lib/wind');

const DEG = Math.PI / 180;
const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

test('stationary boat: true wind equals apparent', () => {
  const t = wind.windFromApparent(10, 40 * DEG, 0);
  close(t.speed, 10);
  close(t.angle, 40 * DEG);
});

test('beam reach: 6 kn boat, true wind 10 kn at 90°', () => {
  // Apparent = true (0, 10) + boat-induced (6, 0)
  const aws = Math.hypot(6, 10);
  const awa = Math.atan2(10, 6);
  const t = wind.windFromApparent(aws, awa, 6);
  close(t.speed, 10);
  close(t.angle, 90 * DEG);
});

test('port side angles stay negative', () => {
  const t = wind.windFromApparent(Math.hypot(6, 10), -Math.atan2(10, 6), 6);
  close(t.angle, -90 * DEG);
});

test('motoring into calm: apparent on the bow is all boat speed', () => {
  const t = wind.windFromApparent(5, 0, 5);
  close(t.speed, 0);
});

test('ground wind with current: COG offset from heading', () => {
  // Boat drifting with the air mass (current pushes it off heading): no ground wind
  const t = wind.windFromApparent(Math.hypot(3, 4), Math.atan2(4, 3) , 5, Math.atan2(4, 3));
  close(t.speed, 0);
});

test('heel correction leaves bow wind untouched and widens beam angles', () => {
  const bow = wind.heelCorrect(10, 0, 20 * DEG);
  close(bow.angle, 0);
  close(bow.speed, 10);
  const beam = wind.heelCorrect(10, 30 * DEG, 20 * DEG);
  assert.ok(beam.angle > 30 * DEG);
  assert.ok(beam.speed > 10);
});

test('height scaling', () => {
  close(wind.speedAtHeight(10, 10, 10), 10);
  assert.ok(wind.speedAtHeight(10, 20, 10) < 10);
});

test('VMG positive upwind, negative downwind', () => {
  assert.ok(wind.velocityMadeGood(6, 45 * DEG) > 0);
  assert.ok(wind.velocityMadeGood(6, 150 * DEG) < 0);
});

test('angle filter averages across the 0/2π wrap', () => {
  const f = new wind.AngleFilter(1);
  f.update(355 * DEG, 0);
  const a = wind.normDirection(f.update(5 * DEG, 1e6));
  close(a, 5 * DEG, 1e-3);
  const g = new wind.AngleFilter(10);
  g.update(355 * DEG, 0);
  const b = wind.normDirection(g.update(5 * DEG, 10));
  assert.ok(b > 355 * DEG || b < 5 * DEG, `drifted the wrong way: ${b / DEG}`);
});

test('window stats: gust, lull, circular mean, expiry', () => {
  const s = new wind.WindowStats(1000);
  s.push(0, 4, 350 * DEG);
  s.push(500, 8, 10 * DEG);
  let r = s.summary();
  close(r.speedAverage, 6);
  close(r.speedMax, 8);
  close(r.speedMin, 4);
  close(r.directionAverage, 0, 1e-9);
  s.push(1600, 6, 10 * DEG);
  r = s.summary();
  close(r.speedMin, 6);
  close(r.speedMax, 6);
});

test('normalisation', () => {
  close(wind.normRelative(270 * DEG), -90 * DEG);
  close(wind.normDirection(-90 * DEG), 270 * DEG);
});

test('current: ground minus water track', () => {
  // Heading north at 5 m/s, pushed east by 1 m/s current
  const c = wind.fromEN(wind.currentVector(0, 5, 0, Math.atan2(1, 5), Math.hypot(1, 5)));
  close(c.speed, 1);
  close(c.direction, 90 * DEG);
});

test('opposite tack mirrors heading about the wind', () => {
  // Starboard tack: wind from 000, heading 315 → port tack heading 045
  const t = wind.oppositeTack(0, 315 * DEG, 6, 0);
  close(t.heading, 45 * DEG);
  close(t.cog, 45 * DEG);
  // Leeway 5° to port on the current tack becomes 5° to starboard after tacking
  const l = wind.oppositeTack(0, 315 * DEG, 6, -5 * DEG);
  close(l.cog, 50 * DEG);
});

test('wind lift sign by tack and point of sail', () => {
  const veer = 10 * DEG;
  assert.ok(wind.windLift(veer, 45 * DEG) > 0, 'upwind starboard veer = lift');
  assert.ok(wind.windLift(veer, -45 * DEG) < 0, 'upwind port veer = header');
  assert.ok(wind.windLift(veer, 150 * DEG) < 0, 'downwind starboard veer = header');
  assert.ok(wind.windLift(veer, -150 * DEG) > 0, 'downwind port veer = lift');
});

test('start line bias', () => {
  // East-west line 1 km long, end order shouldn't matter
  const w = { latitude: 59, longitude: 10.9 };
  const e = { latitude: 59, longitude: 10.9 + 1000 / (111195 * Math.cos(59 * DEG)) };
  close(wind.startLineBias(w, e, 0), 0, 1e-6);
  // Wind from 010: right end facing upwind is the east end, which is ahead
  const b = wind.startLineBias(w, e, 10 * DEG);
  close(b, 1000 * Math.sin(10 * DEG), 1);
  close(wind.startLineBias(e, w, 10 * DEG), b, 1e-6);
  assert.ok(wind.startLineBias(w, e, -10 * DEG) < 0, 'port end favoured');
});
