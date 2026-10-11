const test = require('node:test');
const assert = require('node:assert');
const { TackDetector } = require('../lib/tack');
const polar = require('../lib/polar');
const nav = require('../lib/nav');

const DEG = Math.PI / 180;
const KNOT = 1852 / 3600;
const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

// Feeds 1 Hz samples from a (t seconds) => {twa, stw} function.
function sail(detector, seconds, f, targetVmg) {
  const results = [];
  for (let s = 0; s <= seconds; s++) {
    const { twa, stw } = f(s);
    const r = detector.update(s * 1000, twa, stw * Math.cos(twa), targetVmg);
    if (r) results.push(r);
  }
  return results;
}

test('instant tack at constant speed loses nothing', () => {
  const d = new TackDetector();
  const r = sail(d, 120, (s) => ({ twa: (s < 60 ? 40 : -40) * DEG, stw: 3 }));
  assert.strictEqual(r.length, 1);
  close(r[0].performance, 1, 1e-9);
  close(r[0].loss, 0, 1e-9);
  close(r[0].angle, 80 * DEG, 1e-9);
  assert.strictEqual(r[0].reference, 'preTack');
  close(r[0].time, 60000);
});

test('slow tack with speed drop: loss against target VMG', () => {
  const d = new TackDetector();
  // 8 s turn through the wind, speed down to half, 20 s to recover
  const r = sail(d, 150, (s) => {
    if (s < 60) return { twa: 40 * DEG, stw: 3 };
    if (s < 68) return { twa: (40 - 10 * (s - 60)) * DEG, stw: 3 - 0.1875 * (s - 60) };
    const stw = Math.min(3, 1.5 + 0.075 * (s - 68));
    return { twa: -40 * DEG, stw };
  }, 3 * Math.cos(40 * DEG));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].reference, 'target');
  assert.ok(r[0].performance > 0.6 && r[0].performance < 0.9, `perf ${r[0].performance}`);
  assert.ok(r[0].loss > 10 && r[0].loss < 50, `loss ${r[0].loss}`);
});

test('luffing head to wind and back is not a tack', () => {
  const d = new TackDetector();
  const twas = [40, 40, 30, 10, -5, -8, 10, 30, 40, 40];
  const r = sail(d, 100, (s) => ({ twa: twas[Math.min(Math.floor(s / 10), 9)] * DEG, stw: 2 }));
  assert.strictEqual(r.length, 0);
});

test('gybes are not counted as tacks', () => {
  const d = new TackDetector();
  const r = sail(d, 120, (s) => ({ twa: (s < 60 ? 150 : -150) * DEG, stw: 5 }));
  assert.strictEqual(r.length, 0);
});

const csv = [
  'twa/tws,6,10',
  '40,4.0,5.5',
  '90,5.5,7.0',
  '150,4.0,6.0',
  '180,,5.0'
].join('\n');

test('polar CSV lookup with interpolation and gaps', () => {
  const p = polar.parsePolar(csv);
  close(polar.polarSpeed(p, 6 * KNOT, 40 * DEG), 4 * KNOT);
  close(polar.polarSpeed(p, 8 * KNOT, 65 * DEG), ((4.75 + 6.25) / 2) * KNOT);
  close(polar.polarSpeed(p, 6 * KNOT, -90 * DEG), 5.5 * KNOT, 1e-9);
  // Below the table: clamp to the lowest column
  close(polar.polarSpeed(p, 2 * KNOT, 90 * DEG), 5.5 * KNOT);
  // The 6 kn column has no 180° cell, so only the 10 kn column answers
  close(polar.polarSpeed(p, 6 * KNOT, 170 * DEG), polar.polarSpeed(p, 10 * KNOT, 170 * DEG));
  assert.strictEqual(polar.polarSpeed(p, 6 * KNOT, 20 * DEG), undefined);
});

test('polar file formats: tab and semicolon', () => {
  const tab = polar.parsePolar(csv.replace(/,/g, '\t'));
  const semi = polar.parsePolar(csv.replace(/,/g, ';'));
  close(polar.polarSpeed(tab, 10 * KNOT, 90 * DEG), 7 * KNOT);
  close(polar.polarSpeed(semi, 10 * KNOT, 90 * DEG), 7 * KNOT);
});

test('leg target speed uses beat angle for legs too close to the wind', () => {
  const p = polar.parsePolar(csv);
  const { beat, gybe } = polar.optimumAngles(p, 10 * KNOT);
  assert.ok(beat >= 40 * DEG && beat < 90 * DEG);
  assert.ok(gybe > 90 * DEG);
  close(polar.legTargetSpeed(p, 10 * KNOT, 10 * DEG), polar.polarSpeed(p, 10 * KNOT, beat));
  close(polar.legTargetSpeed(p, 10 * KNOT, 90 * DEG), 7 * KNOT);
});

test('polar-builder data file: active profile, percentile, signed TWA pooled', () => {
  const cell = (tws, twa, samples) => [`${tws}|${twa}`, { tws, twa, samples }];
  const file = {
    version: 2,
    activeProfile: 'race',
    profiles: {
      cruise: { cells: [cell(6, 90, [1, 1, 1])] },
      race: {
        cells: [
          cell(6, 90, [5, 6]),
          cell(6, -90, [7]),
          cell(10, 90, [7, 7, 7]),
          cell(10, 40, [])
        ]
      }
    }
  };
  const p = polar.polarFromBuilder(file, 50);
  assert.deepStrictEqual(p.tws, [6, 10]);
  close(polar.polarSpeed(p, 6 * KNOT, 90 * DEG), 6 * KNOT);
  close(polar.polarSpeed(p, 10 * KNOT, 90 * DEG), 7 * KNOT);
  assert.strictEqual(polar.polarSpeed(p, 10 * KNOT, 40 * DEG), undefined);
  assert.throws(() => polar.polarFromBuilder({}));
});

test('bearing and distance', () => {
  const a = { latitude: 59, longitude: 10.9 };
  close(nav.bearing(a, { latitude: 59.01, longitude: 10.9 }), 0);
  close(nav.bearing(a, { latitude: 58.99, longitude: 10.9 }), Math.PI);
  close(nav.distance(a, { latitude: 59.01, longitude: 10.9 }), 1111.95, 0.1);
});

test('next leg follows route direction', () => {
  const coords = [[10, 59], [10, 59.1], [10.1, 59.1]];
  assert.deepStrictEqual(nav.nextLeg(coords, 1, false), {
    from: { latitude: 59.1, longitude: 10 }, to: { latitude: 59.1, longitude: 10.1 }
  });
  assert.deepStrictEqual(nav.nextLeg(coords, 1, true), {
    from: { latitude: 59.1, longitude: 10 }, to: { latitude: 59, longitude: 10 }
  });
  assert.strictEqual(nav.nextLeg(coords, 2, false), undefined);
});
