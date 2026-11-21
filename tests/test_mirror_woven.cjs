const {test}=require('node:test'),assert=require('node:assert/strict');
const {WovenSession}=require('../mirror/woven-layer.js');
test('woven uses real trace rows, freezes medians and completes exactly twelve bands',()=>{
  let now=0;const s=new WovenSession('fixed',()=>now);
  const packet=(rows,cursor)=>({connected:true,trace:{stream_id:'a',now_s:now,cursor,rows}});
  s.ingest(packet([],0));now=1;s.ingest(packet([{seq:1,t:1,source:'heart_rate',data:{bpm:70}}],1));
  s.ingest(packet([{seq:1,t:1,source:'heart_rate',data:{bpm:200}}],1));
  now=5;s.tick();assert.equal(s.bands[0].values.heart,70);assert.equal(s.bands[0].counts.heart,1);
  const frozen=JSON.stringify(s.bands[0]);now=6;s.ingest(packet([{seq:2,t:6,source:'heart_rate',data:{bpm:90}}],2));
  now=60;assert.equal(s.snapshot().bands.length,12);assert.equal(JSON.stringify(s.bands[0]),frozen);assert.equal(s.bands[1].values.heart,90);
  assert.equal(s.snapshot().status,'running');now=65;assert.equal(s.snapshot().status,'completed');
  assert.ok(s.bands[2].empty);assert.equal(s.bands[2].amplitude.left,null);
});
test('no devices retain deterministic baseline and restart skips historic samples',()=>{
  let now=0;const a=new WovenSession('same',()=>now),b=new WovenSession('same',()=>now);
  now=65;assert.deepEqual(a.snapshot(),b.snapshot());
  const c=new WovenSession('new',()=>now);now=66;
  c.ingest({connected:true,reset:true,trace:{stream_id:'restart',now_s:66,cursor:20,rows:[{seq:20,t:1,source:'heart_rate',data:{bpm:100}}]}});
  now=70;assert.equal(c.snapshot().bands[0].empty,true);
});
