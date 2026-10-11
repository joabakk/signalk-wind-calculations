/*
 * Tack detection and tack loss.
 *
 * Works purely through the water (STW and TWA), so it needs no compass.
 * A tack is a sign change of TWA while upwind, with the boat settled on
 * each side beyond minAngle (hysteresis, so luffing head to wind doesn't
 * count). Once postSeconds have passed after the TWA zero crossing, the
 * distance made to windward over [crossing - pre, crossing + post] is
 * compared with sailing at the reference VMG for the same time:
 *
 *   loss        = refVmg * T - ∫ VMG dt          (metres)
 *   performance = ∫ VMG dt / (refVmg * T)        (1 = no loss)
 *
 * The reference is the polar target VMG when one is available at the
 * moment of the tack, otherwise the boat's own average VMG before it.
 */

const HALF_PI = Math.PI / 2;

class TackDetector {
  constructor({ minAngle = 15 * Math.PI / 180, preSeconds = 10, postSeconds = 30, maxTurnSeconds = 60 } = {}) {
    this.minAngle = minAngle;
    this.pre = preSeconds * 1000;
    this.post = postSeconds * 1000;
    this.maxTurn = maxTurnSeconds * 1000;
    this.samples = [];
    this.side = 0;
    this.sideTime = undefined;
    this.crossing = undefined;
    this.prevTwa = undefined;
    this.pending = undefined;
  }

  /*
   * Feed one sample. t in ms, twa in rad, vmg in m/s, targetVmg (optional)
   * in m/s. Returns a result object once per completed tack:
   *   { time, loss, performance, angle, reference: 'target'|'preTack' }
   */
  update(t, twa, vmg, targetVmg) {
    this.samples.push({ t, twa, vmg });
    const keep = t - (this.pre + this.post + this.maxTurn * 2);
    while (this.samples.length && this.samples[0].t < keep) this.samples.shift();

    const upwind = Math.abs(twa) < HALF_PI;
    if (this.prevTwa !== undefined && upwind && Math.sign(twa) !== Math.sign(this.prevTwa)) {
      this.crossing = t;
    }
    this.prevTwa = twa;

    const side = upwind && Math.abs(twa) >= this.minAngle ? Math.sign(twa) : 0;
    if (side !== 0) {
      if (
        this.side !== 0 && side !== this.side &&
        this.crossing !== undefined && this.crossing >= this.sideTime &&
        t - this.sideTime <= this.maxTurn
      ) {
        this.startTack(t, targetVmg);
      }
      this.side = side;
      this.sideTime = t;
    }

    if (this.pending && t >= this.pending.time + this.post) {
      const result = this.finish();
      this.pending = undefined;
      return result;
    }
    return undefined;
  }

  startTack(t, targetVmg) {
    // Steady sailing before the tack window, so the turn itself doesn't
    // drag down the reference VMG or the angle before the tack.
    const windowStart = this.crossing - this.pre;
    const before = this.between(windowStart - 20000, windowStart);
    let reference = 'target';
    let ref = targetVmg;
    if (!(ref > 0)) {
      reference = 'preTack';
      ref = average(before, 'vmg');
    }
    // A new tack before the previous one finished evaluating: the earlier
    // window is now polluted by this turn, so drop it.
    this.pending = ref > 0.1
      ? { time: this.crossing, ref, reference, angleBefore: average(before, 'twa', Math.abs) }
      : undefined;
  }

  finish() {
    const p = this.pending;
    const window = this.between(p.time - this.pre, p.time + this.post);
    if (window.length < 2) return undefined;
    let made = 0;
    for (let i = 1; i < window.length; i++) {
      const dt = (window[i].t - window[i - 1].t) / 1000;
      made += dt * (window[i].vmg + window[i - 1].vmg) / 2;
    }
    const T = (window[window.length - 1].t - window[0].t) / 1000;
    const ideal = p.ref * T;
    const after = this.between(p.time + this.post - 10000, p.time + this.post);
    return {
      time: p.time,
      loss: ideal - made,
      performance: made / ideal,
      angle: p.angleBefore + average(after, 'twa', Math.abs),
      reference: p.reference
    };
  }

  between(from, to) {
    return this.samples.filter((s) => s.t >= from && s.t <= to);
  }
}

function average(samples, key, f = (x) => x) {
  if (!samples.length) return NaN;
  return samples.reduce((sum, s) => sum + f(s[key]), 0) / samples.length;
}

module.exports = { TackDetector };
