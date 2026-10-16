const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const createPlugin = require('..');

// Minimal stand-in for the server: just enough for the plugin to start,
// take input deltas and publish its own.
function mockApp() {
  const subs = {};
  const app = {
    deltas: [],
    status: undefined,
    debug() {},
    error() {},
    setPluginStatus: (s) => (app.status = s),
    setPluginError: (s) => (app.status = 'error: ' + s),
    handleMessage: (id, delta) => app.deltas.push(delta),
    getDataDirPath: () => path.join(os.tmpdir(), 'signalk-wind-calculations-test', 'signalk-wind-calculations'),
    streambundle: {
      getSelfStream: (p) => ({
        onValue: (f) => {
          subs[p] = f;
          return () => delete subs[p];
        }
      })
    },
    feed: (p, v) => subs[p] && subs[p](v),
    subscriptions: () => Object.keys(subs).length
  };
  return app;
}

function schemaDefaults(schema) {
  const out = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    if ('default' in v) out[k] = v.default;
  }
  return out;
}

test('exports a plugin with id, name, schema, start and stop', () => {
  const plugin = createPlugin(mockApp());
  assert.strictEqual(plugin.id, 'signalk-wind-calculations');
  assert.ok(plugin.name);
  assert.strictEqual(typeof plugin.start, 'function');
  assert.strictEqual(typeof plugin.stop, 'function');
  assert.strictEqual(plugin.schema.type, 'object');
});

test('starts with schema defaults, publishes true wind, stops cleanly', async () => {
  const app = mockApp();
  const plugin = createPlugin(app);
  plugin.start(schemaDefaults(plugin.schema));
  assert.ok(app.deltas[0].updates[0].meta, 'publishes meta for custom paths');

  const DEG = Math.PI / 180;
  app.feed('environment.wind.speedApparent', Math.hypot(3, 5));
  app.feed('environment.wind.angleApparent', Math.atan2(5, 3));
  app.feed('navigation.speedThroughWater', 3);
  await new Promise((r) => setTimeout(r, 700));
  plugin.stop();

  const values = app.deltas.filter((d) => d.updates[0].values).pop().updates[0].values;
  const get = (p) => values.find((v) => v.path === p).value;
  assert.ok(Math.abs(get('environment.wind.speedTrue') - 5) < 1e-9);
  assert.ok(Math.abs(get('environment.wind.angleTrueWater') - 90 * DEG) < 1e-9);
  assert.match(app.status, /missing: heading/);
  assert.strictEqual(app.subscriptions(), 0, 'unsubscribed on stop');
});

test('starts with an empty config', () => {
  const plugin = createPlugin(mockApp());
  plugin.start({});
  plugin.stop();
});

// Beam reach on a magnetic compass: true wind 5 m/s at 90° to the bow
async function magneticRun(config, variation) {
  const app = mockApp();
  const plugin = createPlugin(app);
  plugin.start({ updateInterval: 100, maxAge: 5, ...config });
  if (variation !== undefined) app.feed('navigation.magneticVariation', variation);
  app.feed('environment.wind.speedApparent', Math.hypot(3, 5));
  app.feed('environment.wind.angleApparent', Math.atan2(5, 3));
  app.feed('navigation.speedThroughWater', 3);
  app.feed('navigation.headingMagnetic', 0);
  await new Promise((r) => setTimeout(r, 300));
  plugin.stop();
  const values = app.deltas.filter((d) => d.updates[0].values).pop().updates[0].values;
  const get = (p) => (values.find((v) => v.path === p) || {}).value;
  return { status: app.status, twd: get('environment.wind.directionTrue'), twdMag: get('environment.wind.directionMagnetic') };
}

test('magnetic heading without variation asks for variation, not heading', async () => {
  const r = await magneticRun({});
  assert.match(r.status, /missing: magnetic variation/);
  assert.doesNotMatch(r.status, /missing: heading/);
  assert.strictEqual(r.twd, undefined);
});

test('configured fallback variation turns magnetic heading into true', async () => {
  const DEG = Math.PI / 180;
  const r = await magneticRun({ magneticVariation: 2 });
  assert.ok(Math.abs(r.twd - 92 * DEG) < 1e-9, `twd ${r.twd / DEG}`);
  assert.ok(Math.abs(r.twdMag - 90 * DEG) < 1e-9);
  assert.doesNotMatch(r.status, /variation|heading/);
});

test('variation from the bus is used however old, and beats the fallback', async () => {
  const DEG = Math.PI / 180;
  const realNow = Date.now;
  try {
    // Feed variation, then jump an hour ahead before the other inputs arrive
    const app = mockApp();
    const plugin = createPlugin(app);
    plugin.start({ updateInterval: 100, magneticVariation: 2 });
    app.feed('navigation.magneticVariation', 5 * DEG);
    Date.now = () => realNow() + 3600 * 1000;
    app.feed('environment.wind.speedApparent', Math.hypot(3, 5));
    app.feed('environment.wind.angleApparent', Math.atan2(5, 3));
    app.feed('navigation.speedThroughWater', 3);
    app.feed('navigation.headingMagnetic', 0);
    await new Promise((r) => setTimeout(r, 300));
    plugin.stop();
    const values = app.deltas.filter((d) => d.updates[0].values).pop().updates[0].values;
    const twd = values.find((v) => v.path === 'environment.wind.directionTrue').value;
    assert.ok(Math.abs(twd - 95 * DEG) < 1e-9, `twd ${twd / DEG}`);
  } finally {
    Date.now = realNow;
  }
});

test('warns in the status when TWA reads too wide over several tacks', async () => {
  const DEG = Math.PI / 180;
  const realNow = Date.now;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  let now = realNow();
  const intervals = [];
  try {
    Date.now = () => now;
    global.setInterval = (f, ms) => { const iv = { f, ms, next: now + ms }; intervals.push(iv); return iv; };
    global.clearInterval = (iv) => { const i = intervals.indexOf(iv); if (i >= 0) intervals.splice(i, 1); };
    const app = mockApp();
    const plugin = createPlugin(app);
    plugin.start({ updateInterval: 500, nextLeg: false, laylines: false });
    const t0 = now;
    while (now < t0 + 300000) {
      now += 500;
      const s = (now - t0) / 1000;
      const stb = Math.floor(s / 60) % 2 === 0; // tack every 60 s
      const real = (stb ? 40 : -40) * DEG;
      const measured = real + Math.sign(real) * 4 * DEG; // reads 4° wide
      const ax = 6 * Math.cos(measured) + 3;
      const ay = 6 * Math.sin(measured);
      app.feed('environment.wind.speedApparent', Math.hypot(ax, ay));
      app.feed('environment.wind.angleApparent', Math.atan2(ay, ax));
      app.feed('navigation.speedThroughWater', 3);
      app.feed('navigation.headingTrue', (-real + 2 * Math.PI) % (2 * Math.PI));
      for (const iv of [...intervals]) if (now >= iv.next) { iv.next += iv.ms; await iv.f(); }
    }
    plugin.stop();
    assert.match(app.status, /TWA reads 4\.0° too wide upwind \(last [34] tacks\)/);
  } finally {
    Date.now = realNow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

test('no calibration estimate when heading comes from COG', async () => {
  const DEG = Math.PI / 180;
  const realNow = Date.now;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  let now = realNow();
  const intervals = [];
  try {
    Date.now = () => now;
    global.setInterval = (f, ms) => { const iv = { f, ms, next: now + ms }; intervals.push(iv); return iv; };
    global.clearInterval = (iv) => { const i = intervals.indexOf(iv); if (i >= 0) intervals.splice(i, 1); };
    const app = mockApp();
    const plugin = createPlugin(app);
    plugin.start({ updateInterval: 500, nextLeg: false, laylines: false, useCogAsHeading: true });
    const t0 = now;
    while (now < t0 + 300000) {
      now += 500;
      const s = (now - t0) / 1000;
      const stb = Math.floor(s / 60) % 2 === 0;
      const twa = (stb ? 40 : -40) * DEG;
      const ax = 6 * Math.cos(twa) + 3;
      const ay = 6 * Math.sin(twa);
      app.feed('environment.wind.speedApparent', Math.hypot(ax, ay));
      app.feed('environment.wind.angleApparent', Math.atan2(ay, ax));
      app.feed('navigation.speedThroughWater', 3);
      // No compass; COG is pushed 5° to starboard of heading by current on both tacks
      app.feed('navigation.speedOverGround', 3);
      app.feed('navigation.courseOverGroundTrue', (-twa + 5 * DEG + 2 * Math.PI) % (2 * Math.PI));
      for (const iv of [...intervals]) if (now >= iv.next) { iv.next += iv.ms; await iv.f(); }
    }
    plugin.stop();
    const values = app.deltas.filter((d) => d.updates[0].values).pop().updates[0].values;
    const paths = values.map((v) => v.path);
    assert.ok(paths.includes('performance.tackLoss'), 'tacks still scored');
    assert.ok(paths.includes('environment.wind.directionTrue'), 'TWD from COG still published');
    assert.ok(!paths.includes('performance.trueWindAngleErrorUpwind'), 'no calibration from COG');
    assert.ok(!paths.includes('performance.tackTwdDifference'));
    assert.match(app.status, /heading from COG/);
  } finally {
    Date.now = realNow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});
