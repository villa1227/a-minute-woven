const {test} = require('node:test');
const assert = require('node:assert/strict');
const {draw, drawBand, WIDTH, HEIGHT, QR, PAPER} = require('../web/weave.js');

function context() {
  const calls = [];
  const ctx = new Proxy({}, {
    set(target, key, value) {calls.push([key, value]); target[key] = value; return true;},
    get(target, key) {return target[key] || ((...args) => calls.push([key, ...args]));}
  });
  return {ctx, calls};
}
const band = {index: 0, seed: 'example:0', values: {left: 20, right: 24, heart: 80},
  amplitude: {left: .16, right: .2}, threads: 28, empty: false};

test('deterministic drawing, shared export size and clear QR reserve', () => {
  const a = context(), b = context();
  const artwork = {id: 'example', created_at: '2026-10-21T12:00:00+08:00', bands: [band]};
  draw(a.ctx, artwork); draw(b.ctx, JSON.parse(JSON.stringify(artwork)));
  assert.deepEqual(a.calls, b.calls);
  assert.deepEqual([WIDTH, HEIGHT], [2400, 3200]);
  assert.ok(a.calls.some(call => JSON.stringify(call) === JSON.stringify(['fillRect', QR.x, QR.y, QR.size, QR.size])));
  assert.ok(a.calls.some(call => call[0] === 'fillStyle' && call[1] === PAPER));
  assert.ok(a.calls.some(call => call[0] === 'fillText' && call[1].includes('EXAMPLE')));
});

test('completed bands do not depend on later band data', () => {
  const a = context(), b = context();
  drawBand(a.ctx, band);
  drawBand(b.ctx, band);
  const before = [...b.calls];
  drawBand(b.ctx, {...band, index: 1, seed: 'example:1', amplitude: {left: .24, right: .08}});
  assert.deepEqual(a.calls, before);
});

test('missing eye leaves its color absent while a wholly missing band keeps its baseline', () => {
  const a = context();
  drawBand(a.ctx, {...band, values: {...band.values, right: null}, amplitude: {left: .16, right: null}});
  assert.equal(a.calls.some(call => call[0] === 'strokeStyle' && call[1] === '#af5141'), false);
  const b = context(); drawBand(b.ctx, {...band, empty: true, base_threads: 22,
    values: {left: null, right: null, heart: null}, amplitude: {left: null, right: null}});
  assert.ok(b.calls.some(call => call[0] === 'strokeStyle' && call[1] === '#65757d'));
  assert.equal(b.calls.some(call => call[0] === 'strokeStyle' && call[1] === '#28455e'), false);
  assert.equal(b.calls.some(call => call[0] === 'strokeStyle' && call[1] === '#af5141'), false);
});
