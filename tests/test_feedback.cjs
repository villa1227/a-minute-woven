const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

function harness(payloads) {
  const nodes = new Map(), timers = [], plots = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === 'traceWindow' ? '60' : 'raw', textContent: '', hidden: false,
      style: {setProperty() {}}, classList: {toggle() {}},
      addEventListener() {}, setAttribute() {},
      getBoundingClientRect: () => ({width: 800, height: 150}),
      getContext() {
        if (!plots.has(id)) {
          const lines = [];
          const ctx = new Proxy({lineTo: (...args) => lines.push(args)}, {
            get: (object, key) => object[key] || (() => {})
          });
          plots.set(id, {ctx, lines});
        }
        return plots.get(id).ctx;
      }
    });
    return nodes.get(id);
  };
  const requested = [];
  const context = {
    $: node, token: 'test-only', document: {querySelector: () => ({})},
    window: {devicePixelRatio: 1}, ResizeObserver: class {observe() {}},
    setTimeout: callback => timers.push(callback),
    fetch: async url => {
      requested.push(url);
      assert.ok(payloads.length, 'unexpected polling');
      return {ok: true, json: async () => payloads.shift()};
    }
  };
  vm.runInNewContext(readFileSync(require.resolve('../web/feedback.js'), 'utf8'), context);
  return {node, timers, plots, requested};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const eye = (value, quality = 'candidate_unvalidated') => ({candidate_diameter_px: value, quality});
const camera = (seq, t, left, right) => ({seq, t, source: 'camera', data: {eyes: {
  image_left: eye(left), image_right: right === null ? eye(null, 'no_candidate') : eye(right)
}}});
const heart = (seq, t, bpm, contact = true) => ({seq, t, source: 'heart_rate', data: {bpm, contact_detected: contact}});

test('reference stays within person, preserves separate eyes and clears explicitly', async () => {
  const h = harness([{stream_id: 'one', now_s: 10, cursor: 6, rows: [
    camera(1, 8, 20, 30), camera(2, 9, 22, 32), camera(3, 10, 24, 34),
    heart(4, 8, 70), heart(5, 9, 72), heart(6, 10, 74)
  ]}]);
  await tick();
  assert.equal(h.node('liveLeft').textContent, '24.00 px');
  assert.equal(h.node('liveRight').textContent, '34.00 px');
  h.node('setReference').onclick();
  assert.equal(h.node('traceMode').value, 'relative');
  assert.equal(h.node('deltaLeft').textContent, '较参考 +2.00 px');
  assert.equal(h.node('deltaRight').textContent, '较参考 +2.00 px');
  assert.equal(h.node('deltaHeart').textContent, '较参考 +2.0 bpm');
  assert.equal(h.node('eyeEmpty').hidden, true);
  assert.ok(h.plots.get('eyeTrace').lines.length > 0);
  h.node('clearReference').onclick();
  assert.equal(h.node('traceMode').value, 'raw');
  assert.equal(h.node('clearReference').disabled, true);
});

test('missing eye and contact loss stay empty, stale data do not animate', async () => {
  const h = harness([
    {stream_id: 'one', now_s: 10, cursor: 2, rows: [camera(1, 10, 20, null), heart(2, 10, 74, false)]},
    {stream_id: 'one', now_s: 16, cursor: 2, rows: []}
  ]);
  await tick();
  assert.equal(h.node('liveLeft').textContent, '20.00 px');
  assert.equal(h.node('liveRight').textContent, '—');
  assert.equal(h.node('liveHeart').textContent, '—');
  h.node('setReference').onclick();
  assert.match(h.node('traceStatus').textContent, /采集几秒/);
  await h.timers.shift()();
  assert.equal(h.node('liveLeft').textContent, '—');
  assert.deepEqual(h.requested, ['/api/trace?after=0', '/api/trace?after=2']);
});

test('ROI change invalidates only its reference; restart clears old history', async () => {
  const h = harness([
    {stream_id: 'one', now_s: 10, cursor: 3, rows: [camera(1, 8, 20, 30), camera(2, 9, 22, 32), camera(3, 10, 24, 34)]},
    {stream_id: 'one', now_s: 11, cursor: 5, rows: [
      {seq: 4, t: 10.5, source: 'event', data: {kind: 'camera_roi_changed', side: 'image_left'}},
      camera(5, 11, 25, 35)
    ]},
    {stream_id: 'two', now_s: 1, cursor: 1, rows: []},
    {stream_id: 'two', now_s: 1, cursor: 1, rows: [heart(1, 1, 80)]}
  ]);
  await tick(); h.node('setReference').onclick();
  await h.timers.shift()();
  assert.equal(h.node('deltaLeft').textContent, '候选测量');
  assert.equal(h.node('deltaRight').textContent, '较参考 +3.00 px');
  await h.timers.shift()();
  assert.equal(h.node('referenceStatus').textContent, '还没有个人参考值');
  assert.equal(h.node('liveLeft').textContent, '—');
  assert.equal(h.node('liveHeart').textContent, '80 bpm');
  assert.equal(h.requested.at(-1), '/api/trace?after=0');
});
