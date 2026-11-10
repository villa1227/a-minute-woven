const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PenInput}=require('../mirror/pen-input.js');
const rect={left:10,top:20,width:200,height:100};
function event(type='pointermove',extra={}){return {type,pointerType:'pen',pointerId:7,isPrimary:true,clientX:110,clientY:70,
  pressure:.35,tiltX:12,tiltY:-8,twist:4,button:type==='pointerdown'?0:-1,buttons:1,timeStamp:10,...extra};}
function setup(options={}){const input=new PenInput(options);input.reset(1000,500,'test');return input;}
test('maps CSS pixels and normalized coordinates; retains real pressure and hover is not recorded',()=>{
  const input=setup();input.process(event('pointermove',{buttons:0,pressure:0}),rect);
  assert.equal(input.samples.length,0);assert.equal(input.latest.nx,.5);
  input.process(event('pointerdown'),rect);assert.equal(input.samples[0].x,500);assert.equal(input.samples[0].y,250);
  assert.equal(input.samples[0].pressure,.35);assert.equal(input.samples[0].tiltY,-8);
  input.process(event('pointermove',{clientX:60}),{...rect,width:100,height:50});
  assert.equal(input.latest.x,500);assert.equal(input.latest.y,500);
  input.process(event('pointerup',{buttons:0,pressure:0}),rect);assert.equal(input.active,null);
  assert.equal(input.samples.at(-1).contact,false);
});
test('coalesced batch replaces parent, ignores other pointers and forbidden input',()=>{
  const input=setup();input.process(event('pointerdown'),rect);
  input.process(event('pointermove',{getCoalescedEvents:()=>[event('pointermove',{pressure:.2}),event('pointermove',{pressure:.8,timeStamp:11})]}),rect);
  assert.equal(input.samples.length,3);assert.deepEqual(input.samples.map(s=>s.pressure),[.35,.2,.8]);
  for(const extra of [{pointerType:'touch'},{pointerId:8},{isPrimary:false}])input.process(event('pointerdown',extra),rect);
  assert.equal(input.samples.length,3);
  input.process(event('pointermove',{buttons:3}),rect);assert.equal(input.active,null);
  input.process(event('pointermove'),rect);assert.equal(input.samples.length,3,'no resume after side button');
  input.process(event('pointerdown',{button:5,buttons:32}),rect);assert.equal(input.active,null);
});
test('mouse fallback is explicit, outside preserved, interruption ends stroke and rates expire',()=>{
  let now=100;const input=setup({now:()=>now});
  input.process(event('pointerdown',{pointerType:'mouse',pressure:.5,clientX:-5}),rect);
  assert.equal(input.latest.pointerType,'mouse');assert.equal(input.latest.outside,true);
  assert.equal(input.snapshot().rate,1);input.end('blur');
  input.process(event(),rect);assert.equal(input.samples.length,1);
  now=1200;assert.equal(input.snapshot().rate,0);
  input.mouseFallback=false;input.process(event('pointerdown',{pointerType:'mouse'}),rect);assert.equal(input.samples.length,1);
});
test('limit stops recording and reset restarts without changing exported metadata',()=>{
  const input=setup({limit:2});input.process(event('pointerdown'),rect);input.process(event(),rect);
  assert.equal(input.full,true);assert.equal(input.active,null);input.process(event(),rect);assert.equal(input.samples.length,2);
  const data=input.export();assert.equal(data.schemaVersion,1);assert.equal(data.sessionId,'test');assert.equal(data.canvas.width,1000);
  input.reset(500,250,'new');assert.equal(input.samples.length,0);assert.equal(input.full,false);
  input.process(event('pointerdown'),rect);assert.equal(input.latest.strokeId,1);
});
