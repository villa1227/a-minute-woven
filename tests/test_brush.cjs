const {test}=require('node:test'),assert=require('node:assert/strict');
const {BrushMapping,BASE,PALETTE}=require('../mirror/brush-mapping.js');
const {BrushRenderer}=require('../mirror/brush-renderer.js');
function setup(){let time=0;const m=new BrushMapping(()=>time);m.intensity=1;let seq=0;
  const state={camera_alive:true,heart_alive:true,eda:{connected:true},expression:{running:true,fresh:true}};
  const send=(source,data,t=time)=>m.ingest({connected:true,state,trace:{stream_id:'test',now_s:time,cursor:++seq,rows:[{seq,t,source,data}]}});
  return {m,state,send,set:t=>{time=t;},get:()=>time};}
function eye(left,right){return {eyes:{image_left:{quality:'candidate_unvalidated',candidate_diameter_px:left},image_right:{quality:'candidate_unvalidated',candidate_diameter_px:right}}};}
function eda(adc,segment=0){return {adc,segment,stream_id:'gsr',quality:'received_unvalidated'};}
function expression(label){return {quality:'classified_unvalidated',scores:Object.fromEntries(Object.keys(PALETTE).map(k=>[k,k===label?1:0]))};}
function baseline(s){
  s.send('camera',eye(20,30)); // First packet skips existing history, as real bridge does.
  for(let i=0;i<20;i++){s.set(i*.05);s.send('camera',eye(20,i<2?null:30));s.send('heart_rate',{bpm:70});s.send('eda',eda(500));}
  s.m.setReference();
}
test('independent references, medians, partial eyes and safe signal validity',()=>{
  const s=setup();baseline(s);assert.deepEqual(s.m.references(),{left:20,right:30,heart:70,eda:500});
  s.set(3);s.send('camera',eye(26,null));const t=s.m.target();assert.equal(t.width,4);assert.ok(Math.abs(t.hardness-.6)<1e-9);
  s.send('camera',eye(0,-1));assert.equal(s.m.target().width,2);
  s.send('heart_rate',{bpm:150,contact_detected:false});assert.equal(s.m.value('heart'),null);
  s.send('eda',{...eda(0),quality:'bad'});assert.equal(s.m.value('eda'),null);
  s.send('eda',eda(0));assert.equal(s.m.value('eda'),0,'zero is a valid ADC');
});
test('partial reference counts and reset/reconnect only affect matching channels',()=>{
  const s=setup();s.send('camera',eye(20,null));s.send('camera',eye(20,null));s.send('camera',eye(20,null));
  assert.equal(s.m.setReference().left,null);s.send('camera',eye(20,null));assert.equal(s.m.setReference().left,20);
  baseline(s);s.send('event',{kind:'camera_roi_changed',side:'image_left'});
  assert.equal(s.m.references().left,null);assert.equal(s.m.references().right,30);
  s.send('eda',eda(600,1));assert.equal(s.m.references().eda,null);assert.equal(s.m.references().heart,70);
  s.send('event',{kind:'heart_reset'});assert.equal(s.m.references().heart,null);
  s.m.reset();assert.ok(Object.values(s.m.references()).every(v=>v===null));
});
test('EDA direction, heart rhythm, stale fallback and smooth independent parameters',()=>{
  const s=setup();baseline(s);s.set(3);s.send('eda',eda(600));s.send('heart_rate',{bpm:90});
  const t=s.m.target();assert.ok(Math.abs(t.opacity-.6)<1e-9);assert.equal(t.softness,1.5);assert.equal(t.frequency,70/60,'5-second median');
  s.m.reverseEda=true;assert.equal(s.m.target().opacity,.9);assert.equal(s.m.target().softness,0);
  s.set(10);assert.deepEqual(s.m.target(),{...BASE,color:BASE.color.slice(),intensity:1,textureStrength:1});
  s.m.disconnect();s.set(11);const smooth=s.m.brush();assert.ok(smooth.opacity>.6);
  s.m.enabled=false;assert.deepEqual(s.m.brush().color,[0,0,0]);assert.equal(s.m.brush().width,2);assert.equal(s.m.brush().opacity,1);
});
test('expression color weighting and one-second continuous stable family',()=>{
  const s=setup();s.send('expression',expression('sad'));
  for(const t of [.1,.5,.9,1.2]){s.set(t);s.send('expression',expression('sad'));}
  assert.equal(s.m.target().family,'fiber');assert.deepEqual(s.m.target().color,PALETTE.sad);
  s.set(1.3);s.send('expression',expression('angry'));assert.equal(s.m.target().family,'round');
  const low={quality:'classified_unvalidated',scores:Object.fromEntries(Object.keys(PALETTE).map(k=>[k,1/7]))};
  s.set(1.5);s.send('expression',low);assert.equal(s.m.target().family,'round');
  s.set(3);assert.deepEqual(s.m.target().color,BASE.color);
  s.send('expression',{quality:'no_face',scores:null});assert.equal(s.m.target().family,'round');
});
test('duplicates, poll count and server restarts never add fictitious samples',()=>{
  const s=setup();baseline(s);const count=s.m.channels.left.points.length;
  const p={connected:true,state:s.state,trace:{stream_id:'test',now_s:1,cursor:1000,rows:[]}};
  s.m.ingest(p);s.m.ingest(p);assert.equal(s.m.channels.left.points.length,count);
  s.m.ingest({...p,trace:{...p.trace,rows:[{seq:1,t:1,source:'camera',data:eye(500,500)}]}});
  assert.equal(s.m.channels.left.points.length,count);
  s.m.ingest({...p,reset:true,trace:{...p.trace,stream_id:'new',cursor:1}});assert.equal(s.m.references().left,null);
});
test('continuous brush feedback uses elapsed time for smoothing and independently returns to baseline',()=>{
  const s=setup();baseline(s);s.set(3);s.send('camera',eye(26,null));s.m.updated=3;
  const start=s.m.brush();s.set(3.5);const halfway=s.m.brush();
  assert.equal(start.width,2);assert.ok(halfway.width>2&&halfway.width<4);
  assert.ok(Math.abs(halfway.width-(2+2*(1-Math.exp(-1))))<1e-9);
  s.m.disconnect();s.set(4);const fallback=s.m.brush();assert.ok(fallback.width<halfway.width&&fallback.width>2);
});
function calls(points){const log=[];const ctx=new Proxy({}, {get:(o,k)=>o[k]||((...args)=>log.push([k,...args])),set:(o,k,v)=>{o[k]=v;return true;}});
  const r=new BrushRenderer(ctx,'fixed');const brush={...BASE,color:[54,61,62],family:'grain'};
  for(const [x,time] of points)r.draw({x,y:10,contact:true,outside:false,strokeId:1,eventTimeMs:time},brush);return log;}
test('distance-spaced rendering is deterministic and independent of collinear input batches',()=>{
  assert.deepEqual(calls([[0,0],[10,100]]),calls([[0,0],[2,20],[5,50],[10,100]]));
  assert.deepEqual(calls([[0,0],[10,100]]),calls([[0,0],[10,100]]));
});
test('default stronger feedback amplifies modest real changes, is bounded, and never invents missing signals',()=>{
  assert.equal(new BrushMapping(()=>0).intensity,3);
  const s=setup();baseline(s);s.set(7);s.send('camera',eye(20.8,null));s.send('heart_rate',{bpm:75});s.send('eda',eda(515));
  const mild=s.m.target();s.m.intensity=3;const strong=s.m.target();
  assert.ok(strong.width>mild.width*2);
  assert.ok(strong.wobble>mild.wobble*3);assert.ok(strong.softness>mild.softness*2);
  s.send('expression',expression('happy'));
  assert.ok(s.m.target().color[0]>PALETTE.happy[0]);
  s.m.intensity=5;const extreme=s.m.target();assert.ok(extreme.width<=28&&extreme.wobble<=10.4&&extreme.opacity>=.2);
  s.m.disconnect();const off=s.m.target();assert.equal(off.width,2);assert.equal(off.wobble,0);assert.deepEqual(off.color,BASE.color);
});
