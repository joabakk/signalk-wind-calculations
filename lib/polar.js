/*
 * Polar table: TWA rows x TWS columns, boat speed in knots, angles in
 * degrees. Built either from signalk-polar-builder's live data file, or
 * parsed from an ORC/Expedition-style table (as exported by
 * /plugins/signalk-polar-builder/polar/csv); the delimiter (tab,
 * semicolon, comma or spaces) is sniffed from the header line. Empty
 * cells are allowed; lookups interpolate across the cells that exist.
 *
 * Lookups take and return Signal K units (m/s, rad).
 */

const KNOT = 1852 / 3600;
const DEG = Math.PI / 180;

function parsePolar(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) throw new Error('polar has no data rows');
  const delim = ['\t', ';', ','].find((d) => lines[0].includes(d)) || /\s+/;
  const split = (l) => l.trim().split(delim).map((x) => x.trim());
  const tws = split(lines[0]).slice(1).map(parseFloat);
  if (!tws.length || tws.some((x) => !Number.isFinite(x))) throw new Error('polar header must list TWS values');
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = split(line);
    const twa = parseFloat(parts[0]);
    if (!Number.isFinite(twa)) continue;
    const speeds = tws.map((_, i) => {
      const v = parseFloat(parts[i + 1]);
      return Number.isFinite(v) ? v : null;
    });
    rows.push({ twa, speeds });
  }
  rows.sort((a, b) => a.twa - b.twa);
  if (!rows.length) throw new Error('polar has no data rows');
  return { tws, rows };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/*
 * The active profile of signalk-polar-builder's polars.json (v2 format),
 * reduced the same way its own /polar/matrix does: each cell's speed is
 * the given percentile of its recorded samples. Signed-TWA tables are
 * folded to one side, pooling port and starboard samples.
 */
function polarFromBuilder(json, percentileP = 90) {
  const profile = json.profiles && json.profiles[json.activeProfile];
  const entries = profile ? profile.cells : json.cells;
  if (!Array.isArray(entries)) throw new Error('no polar-builder cells found');
  const pooled = new Map();
  for (const [, c] of entries) {
    if (!c || !Array.isArray(c.samples) || !c.samples.length) continue;
    const twa = Math.abs(c.twa);
    const key = c.tws + '|' + twa;
    if (!pooled.has(key)) pooled.set(key, { tws: c.tws, twa, samples: [] });
    pooled.get(key).samples.push(...c.samples);
  }
  const tws = [...new Set([...pooled.values()].map((c) => c.tws))].sort((a, b) => a - b);
  const twas = [...new Set([...pooled.values()].map((c) => c.twa))].sort((a, b) => a - b);
  const rows = twas.map((twa) => ({
    twa,
    speeds: tws.map((w) => {
      const c = pooled.get(w + '|' + twa);
      return c ? percentile(c.samples, percentileP) : null;
    })
  }));
  return { tws, rows };
}

// Linear interpolation over the non-empty cells of one TWS column.
function alongTwa(polar, col, twaDeg) {
  let lo;
  let hi;
  for (const r of polar.rows) {
    const v = r.speeds[col];
    if (v === null) continue;
    if (r.twa <= twaDeg) lo = { twa: r.twa, v };
    if (r.twa >= twaDeg && !hi) hi = { twa: r.twa, v };
  }
  if (!lo || !hi) return undefined;
  if (hi.twa === lo.twa) return lo.v;
  return lo.v + (hi.v - lo.v) * (twaDeg - lo.twa) / (hi.twa - lo.twa);
}

/*
 * Boat speed (m/s) at a TWS (m/s) and TWA (rad, either side). TWS outside
 * the table is clamped to the nearest column. Undefined if the table has
 * no data around that angle.
 */
function polarSpeed(polar, tws, twa) {
  const twsKn = tws / KNOT;
  const twaDeg = Math.abs(twa) / DEG;
  const cols = polar.tws
    .map((v, i) => ({ v, s: alongTwa(polar, i, twaDeg) }))
    .filter((c) => c.s !== undefined);
  if (!cols.length) return undefined;
  if (twsKn <= cols[0].v) return cols[0].s * KNOT;
  const last = cols[cols.length - 1];
  if (twsKn >= last.v) return last.s * KNOT;
  const i = cols.findIndex((c) => c.v >= twsKn);
  const a = cols[i - 1];
  const b = cols[i];
  return (a.s + (b.s - a.s) * (twsKn - a.v) / (b.v - a.v)) * KNOT;
}

/*
 * Best VMG angles at a TWS, searched in 1° steps: beat (upwind) and gybe
 * (downwind). Returned in rad, positive.
 */
function optimumAngles(polar, tws) {
  let beat;
  let gybe;
  let bestUp = 0;
  let bestDown = 0;
  for (let deg = 1; deg < 180; deg++) {
    const s = polarSpeed(polar, tws, deg * DEG);
    if (s === undefined) continue;
    const vmg = s * Math.cos(deg * DEG);
    if (vmg > bestUp) { bestUp = vmg; beat = deg * DEG; }
    if (-vmg > bestDown) { bestDown = -vmg; gybe = deg * DEG; }
  }
  return { beat, gybe };
}

/*
 * Target boat speed for a leg sailed at legTwa: the polar speed at that
 * angle, or at the beat/gybe angle if the leg is too close to the wind
 * (or too deep) to sail straight and has to be tacked or gybed.
 */
function legTargetSpeed(polar, tws, legTwa) {
  const { beat, gybe } = optimumAngles(polar, tws);
  let a = Math.abs(legTwa);
  if (beat !== undefined && a < beat) a = beat;
  if (gybe !== undefined && a > gybe) a = gybe;
  return polarSpeed(polar, tws, a);
}

module.exports = { parsePolar, polarFromBuilder, polarSpeed, optimumAngles, legTargetSpeed };
