/*
 * signalk-wind-calculations
 *
 * Derives true wind (water-referenced), ground wind, VMG and rolling
 * wind statistics from the apparent wind and the boat's own motion, plus
 * the tactical values B&G displays expect (see the signalk-bandg-performance
 * plugin): current set/drift, opposite tack course, VMG performance, wind
 * phase/lift, start line bias, tack loss, next leg and dead reckoning.
 *
 * Inputs are read from the latest self values and recalculated on a fixed
 * interval; any input older than maxAge is treated as missing, so outputs
 * stop rather than freeze when a sensor drops out.
 */
const fs = require('fs');
const path = require('path');
const wind = require('./lib/wind');
const polarLib = require('./lib/polar');
const nav = require('./lib/nav');
const { TackDetector } = require('./lib/tack');

const pluginId = 'signalk-wind-calculations';
const DEG = Math.PI / 180;
const KNOT = 1852 / 3600;

const INPUT_PATHS = [
  'environment.wind.angleApparent',
  'environment.wind.speedApparent',
  'navigation.speedThroughWater',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.attitude',
  'performance.beatAngleVelocityMadeGood',
  'performance.gybeAngleVelocityMadeGood',
  'navigation.racing.startLineStb',
  'navigation.racing.startLinePort',
  'racecontrol'
];

// Paths that aren't in the Signal K spec need their own meta so clients
// know the units.
const CUSTOM_META = [
  { path: 'environment.wind.directionGround', units: 'rad', description: 'Ground wind direction (wind relative to the seabed), true' },
  { path: 'environment.wind.speedTrueReferenceHeight', units: 'm/s', description: 'True wind speed scaled to the reference height' },
  { path: 'environment.wind.speedTrueAverage', units: 'm/s', description: 'Average true wind speed over the statistics window' },
  { path: 'environment.wind.speedTrueMax', units: 'm/s', description: 'Highest true wind speed (gust) over the statistics window' },
  { path: 'environment.wind.speedTrueMin', units: 'm/s', description: 'Lowest true wind speed (lull) over the statistics window' },
  { path: 'environment.wind.directionTrueAverage', units: 'rad', description: 'Mean true wind direction over the statistics window' },
  { path: 'environment.wind.phase', units: 'rad', description: 'True wind direction minus its average; positive = veered' },
  { path: 'performance.windLift', units: 'rad', description: 'Wind shift relative to the current tack; positive = lift' },
  { path: 'performance.velocityMadeGoodRatio', units: 'ratio', description: 'VMG as a fraction of the polar target VMG' },
  { path: 'environment.currentDrift', units: 'm/s', description: 'Current speed (same as environment.current.drift, as a plain number for consumers that can\'t read objects)' },
  { path: 'environment.currentSetTrue', units: 'rad', description: 'Current direction, true (same as environment.current.setTrue)' },
  { path: 'performance.oppositeTackCourseOverGroundTrue', units: 'rad', description: 'Expected COG after tacking or gybing' },
  { path: 'navigation.racing.startLineBias', units: 'm', description: 'How much further upwind the starboard end of the start line is; negative = port end favoured' },
  { path: 'performance.tackLoss', units: 'm', description: 'Distance to windward lost in the last tack, compared with sailing at the reference VMG' },
  { path: 'performance.tackingPerformance', units: 'ratio', description: 'Windward distance made during the last tack as a fraction of the reference VMG; 1 = no loss' },
  { path: 'performance.tackAngle', units: 'rad', description: 'Angle tacked through in the last tack (sum of TWA before and after)' },
  { path: 'navigation.nextLeg.bearingTrue', units: 'rad', description: 'Bearing of the route leg after the current destination' },
  { path: 'navigation.nextLeg.distance', units: 'm', description: 'Length of the route leg after the current destination' },
  { path: 'performance.nextLegTrueWindAngle', units: 'rad', description: 'TWA the next leg would be sailed at in the current wind' },
  { path: 'performance.nextLegTargetSpeed', units: 'm/s', description: 'Polar boat speed for the next leg (at beat/gybe angle if it has to be tacked/gybed)' },
  { path: 'navigation.deadReckoning.bearingTrue', units: 'rad', description: 'Direction of the distance sailed through the water since the last reset' },
  { path: 'navigation.deadReckoning.bearingMagnetic', units: 'rad', description: 'Dead reckoning bearing, magnetic' },
  { path: 'navigation.deadReckoning.distance', units: 'm', description: 'Straight-line distance sailed through the water since the last reset' }
];

module.exports = function (app) {
  const plugin = {};
  const debug = app.debug;

  plugin.id = pluginId;
  plugin.name = 'Wind Calculations';
  plugin.description =
    'True and ground wind, current, VMG performance, wind shifts and start line bias from apparent wind.';

  plugin.schema = {
    type: 'object',
    properties: {
      updateInterval: {
        type: 'number',
        title: 'Update interval (ms)',
        default: 500,
        minimum: 100
      },
      maxAge: {
        type: 'number',
        title: 'Max input age (seconds)',
        description: 'Inputs older than this are ignored, so outputs stop when a sensor goes quiet.',
        default: 5,
        minimum: 1
      },
      trueWind: {
        type: 'boolean',
        title: 'Calculate true wind (angleTrueWater, speedTrue, directionTrue, directionMagnetic)',
        description: 'Turn off if another plugin (e.g. signalk-derived-data) already publishes these paths.',
        default: true
      },
      groundWind: {
        type: 'boolean',
        title: 'Calculate ground wind (angleTrueGround, speedOverGround, directionGround)',
        default: true
      },
      vmg: {
        type: 'boolean',
        title: 'Calculate VMG to wind (performance.velocityMadeGood)',
        description: 'Turn off if signalk-polar-builder or signalk-derived-data already publishes it.',
        default: true
      },
      vmgRatio: {
        type: 'boolean',
        title: 'Calculate VMG performance (performance.velocityMadeGoodRatio)',
        description: 'Needs target VMG from a polar plugin (performance.beatAngleVelocityMadeGood / gybeAngleVelocityMadeGood).',
        default: true
      },
      useCogAsHeading: {
        type: 'boolean',
        title: 'Use COG when no heading is available',
        description: 'For boats without a compass. Ignores leeway and current, so wind direction will be less accurate, and current cannot be calculated.',
        default: false
      },
      minCogSpeed: {
        type: 'number',
        title: 'Min SOG for using COG as heading (knots)',
        description: 'COG is noise at low speed, so it is not used as heading below this.',
        default: 1,
        minimum: 0
      },
      useLeeway: {
        type: 'boolean',
        title: 'Account for leeway in true wind, current and opposite tack',
        default: false
      },
      leewayPath: {
        type: 'string',
        title: 'Leeway path',
        description: 'Positive = sliding to starboard. signalk-derived-data publishes performance.leeway.',
        default: 'navigation.leewayAngle'
      },
      heelCorrection: {
        type: 'boolean',
        title: 'Correct apparent wind for heel (uses navigation.attitude.roll)',
        default: false
      },
      maxHeel: {
        type: 'number',
        title: 'Max heel for correction (degrees)',
        description: 'Heel beyond this is clamped, since the correction blows up near 90°.',
        default: 45,
        minimum: 0,
        maximum: 80
      },
      damping: {
        type: 'number',
        title: 'Damping time constant (seconds)',
        description: '0 disables smoothing of outputs.',
        default: 0,
        minimum: 0
      },
      current: {
        type: 'boolean',
        title: 'Calculate current set and drift (environment.current)',
        description: 'Needs a real compass heading and STW; never calculated from COG.',
        default: true
      },
      currentDamping: {
        type: 'number',
        title: 'Current damping time constant (seconds)',
        default: 30,
        minimum: 0
      },
      oppositeTack: {
        type: 'boolean',
        title: 'Calculate opposite tack COG (performance.oppositeTackCourseOverGroundTrue)',
        default: true
      },
      tackTrue: {
        type: 'boolean',
        title: 'Publish opposite tack heading (performance.tackTrue)',
        description: 'signalk-polar-builder publishes this when there is a compass heading. Enable for boats without one, together with "Use COG when no heading is available".',
        default: false
      },
      heightCorrection: {
        type: 'boolean',
        title: 'Publish true wind speed scaled to reference height (environment.wind.speedTrueReferenceHeight)',
        default: false
      },
      mastheadHeight: {
        type: 'number',
        title: 'Wind sensor height above water (m)',
        default: 15,
        minimum: 0.5
      },
      referenceHeight: {
        type: 'number',
        title: 'Reference height (m)',
        default: 10,
        minimum: 0.5
      },
      profileExponent: {
        type: 'number',
        title: 'Wind profile exponent',
        description: 'Power-law exponent; ~0.11 over open water.',
        default: 0.11,
        minimum: 0
      },
      statistics: {
        type: 'boolean',
        title: 'Publish true wind average / gust / lull / mean direction, wind phase and lift',
        default: true
      },
      statisticsWindow: {
        type: 'number',
        title: 'Statistics window (minutes)',
        default: 10,
        minimum: 0.5
      },
      startLineBias: {
        type: 'boolean',
        title: 'Calculate start line bias (navigation.racing.startLineBias)',
        description: 'Uses navigation.racing.startLineStb/Port, or the start line from signalk-race-control.',
        default: true
      },
      tackAnalysis: {
        type: 'boolean',
        title: 'Calculate tack loss / tacking performance after each tack',
        description: 'Needs only STW and apparent wind (no compass). Uses polar target VMG as reference when available, else the VMG before the tack.',
        default: true
      },
      minTackAngle: {
        type: 'number',
        title: 'Min TWA on each side to count as a tack (degrees)',
        default: 15,
        minimum: 1
      },
      tackPreSeconds: {
        type: 'number',
        title: 'Tack window before crossing the wind (seconds)',
        default: 10,
        minimum: 0
      },
      tackPostSeconds: {
        type: 'number',
        title: 'Tack window after crossing the wind (seconds)',
        description: 'Long enough to get back up to speed.',
        default: 30,
        minimum: 5
      },
      nextLeg: {
        type: 'boolean',
        title: 'Calculate next leg bearing, distance, TWA and target speed',
        description: 'Uses the active route from the course API.',
        default: true
      },
      polarFile: {
        type: 'string',
        title: 'Polar file (for next leg target speed)',
        description: 'Leave blank to use the live polar from signalk-polar-builder. Otherwise a TWA x TWS table in knots (CSV, tab or semicolon separated), absolute or relative to the Signal K config folder.',
        default: ''
      },
      deadReckoning: {
        type: 'boolean',
        title: 'Calculate dead reckoning bearing and distance through the water since reset',
        description: 'Needs a compass heading. Reset with a PUT to navigation.deadReckoning.reset or POST /plugins/signalk-wind-calculations/deadReckoning/reset.',
        default: true
      },
      resetDeadReckoningAtStart: {
        type: 'boolean',
        title: 'Reset dead reckoning at the race start (signalk-race-control)',
        default: true
      }
    }
  };

  let options;
  let unsubscribes = [];
  let timer;
  let latest = {};
  let filters;
  let stats;
  let lastTick;
  let tacks;
  let lastTack;
  let polar;
  let polarStatus;
  let polarMtime;
  let leg;
  let routeHref;
  let routeCoords;
  let dr;
  let raceStart;
  let timers = [];

  function filtersFor(tau, currentTau) {
    return {
      twa: new wind.AngleFilter(tau),
      tws: new wind.SpeedFilter(tau),
      twd: new wind.AngleFilter(tau),
      gwa: new wind.AngleFilter(tau),
      gws: new wind.SpeedFilter(tau),
      gwd: new wind.AngleFilter(tau),
      vmg: new wind.SpeedFilter(tau),
      currentE: new wind.SpeedFilter(currentTau),
      currentN: new wind.SpeedFilter(currentTau)
    };
  }

  function fresh(path, now) {
    const v = latest[path];
    if (!v || now - v.t > options.maxAge * 1000) return undefined;
    return v.value;
  }

  function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  // { value, compass } - compass is false when COG stands in for heading
  function heading(now) {
    const hdt = fresh('navigation.headingTrue', now);
    if (isNum(hdt)) return { value: hdt, compass: true };
    const hdm = fresh('navigation.headingMagnetic', now);
    const variation = fresh('navigation.magneticVariation', now);
    if (isNum(hdm) && isNum(variation)) return { value: hdm + variation, compass: true };
    if (options.useCogAsHeading) {
      const cog = fresh('navigation.courseOverGroundTrue', now);
      const sog = fresh('navigation.speedOverGround', now);
      if (isNum(cog) && isNum(sog) && sog >= options.minCogSpeed * KNOT) {
        return { value: cog, compass: false };
      }
    }
    return { value: undefined, compass: false };
  }

  // Both ends as {latitude, longitude}, from the Signal K racing paths or
  // signalk-race-control. Not age-checked: a start line rarely changes.
  function startLine() {
    const stb = latest['navigation.racing.startLineStb'];
    const port = latest['navigation.racing.startLinePort'];
    if (stb && port && stb.value && port.value) return [stb.value, port.value];
    const race = latest.racecontrol && latest.racecontrol.value;
    const line = race && race.startLine;
    if (Array.isArray(line) && line.length === 2 && line.every((p) => p && isNum(p.lat) && isNum(p.lon))) {
      return line.map((p) => ({ latitude: p.lat, longitude: p.lon }));
    }
    return undefined;
  }

  function resetDeadReckoning(why) {
    dr = { e: 0, n: 0 };
    debug('dead reckoning reset (%s)', why);
  }

  // Next leg target speed needs the whole polar, not just the values
  // polar-builder publishes for the current TWA, so read its data file
  // (a sibling of ours in plugin-config-data) and reload when it changes.
  function polarSource() {
    if (options.polarFile) {
      const configDir = app.config && app.config.configPath ? app.config.configPath : '.';
      return { file: path.resolve(configDir, options.polarFile) };
    }
    const dataRoot = path.dirname(app.getDataDirPath());
    return {
      file: path.join(dataRoot, 'polar-builder', 'polars.json'),
      config: path.join(dataRoot, 'polar-builder.json')
    };
  }

  function loadPolar() {
    let src = {};
    try {
      src = polarSource();
      const mtime = fs.statSync(src.file).mtimeMs;
      if (mtime === polarMtime) return;
      const text = fs.readFileSync(src.file, 'utf8');
      if (src.config) {
        let pct = 90;
        try {
          const cfg = JSON.parse(fs.readFileSync(src.config, 'utf8'));
          if (cfg.configuration && isNum(cfg.configuration.percentile)) pct = cfg.configuration.percentile;
        } catch (e) {
          // polar-builder running on its defaults
        }
        polar = polarLib.polarFromBuilder(JSON.parse(text), pct);
      } else {
        polar = polarLib.parsePolar(text);
      }
      polarMtime = mtime;
      polarStatus = undefined;
      debug('loaded polar from %s (%d TWS x %d TWA)', src.file, polar.tws.length, polar.rows.length);
    } catch (e) {
      polar = undefined;
      polarMtime = undefined;
      polarStatus = e.code === 'ENOENT' ? 'not found at ' + src.file : e.message;
    }
  }

  async function refreshCourse() {
    try {
      const course = app.getCourse ? await app.getCourse() : undefined;
      const route = course && course.activeRoute;
      if (!route || !route.href) {
        leg = undefined;
        return;
      }
      if (route.href !== routeHref) {
        const id = route.href.split('/').pop();
        const resource = await app.resourcesApi.getResource('routes', id);
        routeCoords = resource.feature.geometry.coordinates;
        routeHref = route.href;
      }
      leg = nav.nextLeg(routeCoords, route.pointIndex, route.reverse);
    } catch (e) {
      leg = undefined;
      routeHref = undefined;
      debug('course lookup failed: %s', e.message);
    }
  }

  function calculate() {
    const now = Date.now();
    const dt = lastTick ? (now - lastTick) / 1000 : 0;
    lastTick = now;

    let aws = fresh('environment.wind.speedApparent', now);
    let awa = fresh('environment.wind.angleApparent', now);
    if (!isNum(aws) || !isNum(awa)) {
      app.setPluginStatus('Waiting for apparent wind');
      return;
    }

    if (options.heelCorrection) {
      const attitude = fresh('navigation.attitude', now);
      if (attitude && isNum(attitude.roll)) {
        const limit = options.maxHeel * DEG;
        const heel = Math.max(-limit, Math.min(limit, attitude.roll));
        ({ speed: aws, angle: awa } = wind.heelCorrect(aws, awa, heel));
      }
    }

    const { value: hdg, compass } = heading(now);
    const variation = fresh('navigation.magneticVariation', now);
    const stw = fresh('navigation.speedThroughWater', now);
    const sog = fresh('navigation.speedOverGround', now);
    const cog = fresh('navigation.courseOverGroundTrue', now);
    let leeway = 0;
    if (options.useLeeway) {
      const l = fresh(options.leewayPath, now);
      if (isNum(l)) leeway = l;
    }
    const values = [];
    const missing = [];
    let twa;
    let tws;
    let twd;
    let current;

    if (!isNum(hdg)) missing.push('heading');

    if (isNum(stw)) {
      const t = wind.windFromApparent(aws, awa, stw, leeway);
      twa = t.angle;
      tws = filters.tws.update(t.speed, dt);
      const twaDamped = filters.twa.update(t.angle, dt);
      if (isNum(hdg)) {
        twd = wind.normDirection(filters.twd.update(hdg + t.angle, dt));
      }

      if (options.trueWind) {
        values.push(
          { path: 'environment.wind.angleTrueWater', value: twaDamped },
          { path: 'environment.wind.speedTrue', value: tws }
        );
        if (isNum(twd)) {
          values.push({ path: 'environment.wind.directionTrue', value: twd });
          if (isNum(variation)) {
            values.push({
              path: 'environment.wind.directionMagnetic',
              value: wind.normDirection(twd - variation)
            });
          }
        }
        if (options.heightCorrection) {
          values.push({
            path: 'environment.wind.speedTrueReferenceHeight',
            value: wind.speedAtHeight(tws, options.mastheadHeight, options.referenceHeight, options.profileExponent)
          });
        }
      }

      const vmg = wind.velocityMadeGood(stw, t.angle);
      if (options.vmg) {
        values.push({ path: 'performance.velocityMadeGood', value: filters.vmg.update(vmg, dt) });
      }
      if (options.vmgRatio) {
        const target = fresh(
          vmg >= 0 ? 'performance.beatAngleVelocityMadeGood' : 'performance.gybeAngleVelocityMadeGood',
          now
        );
        if (isNum(target) && Math.abs(target) > 0.05) {
          values.push({ path: 'performance.velocityMadeGoodRatio', value: Math.abs(vmg) / Math.abs(target) });
        } else {
          missing.push('target VMG');
        }
      }
    } else {
      missing.push('STW');
    }

    if (options.current && compass && isNum(stw) && isNum(sog) && isNum(cog)) {
      const c = wind.currentVector(hdg, stw, leeway, cog, sog);
      current = { e: filters.currentE.update(c.e, dt), n: filters.currentN.update(c.n, dt) };
      const { speed, direction } = wind.fromEN(current);
      const value = { drift: speed, setTrue: direction };
      if (isNum(variation)) value.setMagnetic = wind.normDirection(direction - variation);
      values.push(
        { path: 'environment.current', value },
        { path: 'environment.currentDrift', value: speed },
        { path: 'environment.currentSetTrue', value: direction }
      );
    }

    if (isNum(twd) && isNum(hdg) && isNum(stw) && (options.oppositeTack || options.tackTrue)) {
      const opp = wind.oppositeTack(twd, hdg, stw, leeway, current);
      if (options.oppositeTack) {
        values.push({ path: 'performance.oppositeTackCourseOverGroundTrue', value: opp.cog });
      }
      if (options.tackTrue) {
        values.push({ path: 'performance.tackTrue', value: opp.heading });
        if (isNum(variation)) {
          values.push({ path: 'performance.tackMagnetic', value: wind.normDirection(opp.heading - variation) });
        }
      }
    }

    if (options.groundWind) {
      if (isNum(sog) && isNum(cog) && isNum(hdg)) {
        const g = wind.windFromApparent(aws, awa, sog, cog - hdg);
        values.push(
          { path: 'environment.wind.angleTrueGround', value: filters.gwa.update(g.angle, dt) },
          { path: 'environment.wind.speedOverGround', value: filters.gws.update(g.speed, dt) },
          { path: 'environment.wind.directionGround', value: wind.normDirection(filters.gwd.update(hdg + g.angle, dt)) }
        );
      } else if (!isNum(sog) || !isNum(cog)) {
        missing.push('SOG/COG');
      }
    }

    let avgTwd;
    if (options.statistics && isNum(tws)) {
      stats.push(now, tws, twd);
      const s = stats.summary();
      values.push(
        { path: 'environment.wind.speedTrueAverage', value: s.speedAverage },
        { path: 'environment.wind.speedTrueMax', value: s.speedMax },
        { path: 'environment.wind.speedTrueMin', value: s.speedMin }
      );
      if (s.directionAverage !== undefined) {
        avgTwd = s.directionAverage;
        values.push({ path: 'environment.wind.directionTrueAverage', value: avgTwd });
        if (isNum(twd)) {
          const phase = wind.normRelative(twd - avgTwd);
          values.push(
            { path: 'environment.wind.phase', value: phase },
            { path: 'performance.windLift', value: wind.windLift(phase, twa) }
          );
        }
      }
    }

    if (options.startLineBias) {
      const line = startLine();
      const dir = isNum(avgTwd) ? avgTwd : twd;
      if (line && isNum(dir)) {
        values.push({ path: 'navigation.racing.startLineBias', value: wind.startLineBias(line[0], line[1], dir) });
      }
    }

    if (options.tackAnalysis && isNum(twa) && isNum(stw)) {
      const target = fresh('performance.beatAngleVelocityMadeGood', now);
      const r = tacks.update(now, twa, wind.velocityMadeGood(stw, twa), target);
      if (r) {
        lastTack = r;
        debug('tack: %j', r);
      }
      if (lastTack) {
        values.push(
          { path: 'performance.tackLoss', value: lastTack.loss },
          { path: 'performance.tackingPerformance', value: lastTack.performance },
          { path: 'performance.tackAngle', value: lastTack.angle }
        );
      }
    }

    if (options.nextLeg && leg) {
      const bearing = nav.bearing(leg.from, leg.to);
      values.push(
        { path: 'navigation.nextLeg.bearingTrue', value: bearing },
        { path: 'navigation.nextLeg.distance', value: nav.distance(leg.from, leg.to) }
      );
      if (isNum(twd)) {
        const legTwa = wind.normRelative(twd - bearing);
        values.push({ path: 'performance.nextLegTrueWindAngle', value: legTwa });
        const target = polar && isNum(tws) ? polarLib.legTargetSpeed(polar, tws, legTwa) : undefined;
        if (isNum(target)) values.push({ path: 'performance.nextLegTargetSpeed', value: target });
      }
    }

    if (options.deadReckoning) {
      if (options.resetDeadReckoningAtStart) {
        const race = latest.racecontrol && latest.racecontrol.value;
        const start = race && race.startTime;
        if (start && start !== raceStart) resetDeadReckoning('race start');
        raceStart = start;
      }
      if (compass && isNum(stw) && dt > 0 && dt < 5) {
        const v = wind.toEN(stw, hdg + leeway);
        dr.e += v.e * dt;
        dr.n += v.n * dt;
      }
      if (compass) {
        const { speed: distance, direction } = wind.fromEN(dr);
        values.push(
          { path: 'navigation.deadReckoning.distance', value: distance },
          { path: 'navigation.deadReckoning.bearingTrue', value: direction }
        );
        if (isNum(variation)) {
          values.push({ path: 'navigation.deadReckoning.bearingMagnetic', value: wind.normDirection(direction - variation) });
        }
      }
    }

    if (values.length) {
      app.handleMessage(pluginId, { updates: [{ values }] });
    }
    let note = isNum(hdg) && !compass ? ' (heading from COG)' : '';
    if (options.nextLeg && polarStatus) note += `; polar: ${polarStatus}`;
    app.setPluginStatus(
      (missing.length ? `Running, missing: ${missing.join(', ')}` : 'Running') + note
    );
  }

  plugin.start = function (opts) {
    const defaults = {};
    for (const [k, v] of Object.entries(plugin.schema.properties)) {
      defaults[k] = v.default;
    }
    options = { ...defaults, ...opts };
    latest = {};
    lastTick = undefined;
    filters = filtersFor(options.damping, options.currentDamping);
    stats = new wind.WindowStats(options.statisticsWindow * 60 * 1000);
    tacks = new TackDetector({
      minAngle: options.minTackAngle * DEG,
      preSeconds: options.tackPreSeconds,
      postSeconds: options.tackPostSeconds
    });
    lastTack = undefined;
    leg = undefined;
    routeHref = undefined;
    raceStart = undefined;
    resetDeadReckoning('start');
    polar = undefined;
    polarMtime = undefined;
    polarStatus = undefined;

    app.handleMessage(pluginId, {
      updates: [{
        meta: CUSTOM_META.map(({ path, units, description }) => ({
          path,
          value: { units, description }
        }))
      }]
    });

    const paths = [...new Set([...INPUT_PATHS, options.leewayPath])];
    unsubscribes = paths.map((path) =>
      app.streambundle.getSelfStream(path).onValue((value) => {
        latest[path] = { value, t: Date.now() };
      })
    );

    timer = setInterval(calculate, options.updateInterval);
    if (options.nextLeg) {
      loadPolar();
      refreshCourse();
      timers.push(setInterval(loadPolar, 30000), setInterval(refreshCourse, 5000));
    }
    if (options.deadReckoning && app.registerPutHandler) {
      app.registerPutHandler('vessels.self', 'navigation.deadReckoning.reset', () => {
        resetDeadReckoning('PUT');
        return { state: 'COMPLETED', statusCode: 200 };
      }, pluginId);
    }
    debug('started with %j', options);
    app.setPluginStatus('Started');
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    if (timer) clearInterval(timer);
    timer = undefined;
    timers.forEach(clearInterval);
    timers = [];
  };

  plugin.registerWithRouter = function (router) {
    router.post('/deadReckoning/reset', (req, res) => {
      resetDeadReckoning('HTTP');
      res.json({ ok: true });
    });
  };

  return plugin;
};
