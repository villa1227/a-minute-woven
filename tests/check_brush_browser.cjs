// Uses synthetic sensor responses and pen events; no real sensor reads/writes.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/brush.synthetic.json'),'utf8'));
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let seq=0,now=0,mode='base',connected=true,stream='synthetic';
  await page.route('**/api/sensors*',async route=>{
    const rows=[],t=now;now+=.2;const values=mode==='base'?fixture.baseline:fixture.changed;
    const push=(source,data)=>rows.push({seq:++seq,t,source,data});
    push('camera',{eyes:{image_left:{quality:'candidate_unvalidated',candidate_diameter_px:values.left},image_right:{quality:'candidate_unvalidated',candidate_diameter_px:values.right}}});
    push('heart_rate',{bpm:values.heart,quality:'received'});
    for(let i=0;i<4;i++)push('eda',{adc:values.eda,segment:0,stream_id:'gsr',quality:'received_unvalidated'});
    push('expression',fixture.expression);
    const reset=!new URL(route.request().url()).searchParams.has('after');
    await route.fulfill({json:{connected,reset,state:fixture.state,trace:connected?{stream_id:stream,now_s:now,cursor:seq,rows:reset?[]:rows}:null}});
  });
  await page.goto('http://127.0.0.1:8767/');
  await page.evaluate(()=>{
    const c=document.getElementById('lineCanvas');c.width=600;c.height=800;c.hidden=false;c.getContext('2d').fillStyle='white';c.getContext('2d').fillRect(0,0,600,800);
    MirrorTracing.enable(600,800,'synthetic-brush');
  });
  await page.waitForFunction(()=>MirrorSensors.mapping.channels.eda.points.length>=20);
  await page.click('#setBrushReference');
  const references=await page.evaluate(()=>MirrorSensors.mapping.references());assert.deepEqual(references,{left:20,right:24,heart:72,eda:500});
  const before=await page.evaluate(()=>MirrorSensors.mapping.target());mode='change';
  await page.waitForFunction(()=>MirrorSensors.mapping.target().width>3.5);
  await page.waitForFunction(()=>MirrorSensors.mapping.target().frequency>1.4);
  const changed=await page.evaluate(()=>MirrorSensors.mapping.target());assert.ok(changed.softness>before.softness);assert.ok(changed.opacity<before.opacity);assert.ok(changed.wobble>before.wobble);
  await page.click('#reverseEda');await page.waitForFunction(()=>MirrorSensors.mapping.target().softness===0);
  assert.ok(await page.evaluate(()=>MirrorSensors.mapping.target().opacity>=.95));
  async function stroke(y){await page.locator('#tracingCanvas').evaluate((c,y)=>{
    const r=c.getBoundingClientRect();for(const [i,x] of [.15,.25,.4,.55,.7].entries())c.dispatchEvent(new PointerEvent(i?'pointermove':'pointerdown',{
      pointerType:'pen',pointerId:99,isPrimary:true,button:i?-1:0,buttons:1,pressure:.73,clientX:r.left+x*r.width,clientY:r.top+y*r.height,bubbles:true}));
    c.dispatchEvent(new PointerEvent('pointerup',{pointerType:'pen',pointerId:99,isPrimary:true,buttons:0,pressure:0,clientX:r.left+.7*r.width,clientY:r.top+y*r.height,bubbles:true}));
  },y);}
  await stroke(.2);
  const inkColor=await page.locator('#tracingCanvas').evaluate(c=>{
    const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>100&&pixels[i]>0)return [pixels[i],pixels[i+1],pixels[i+2]];
    return null;
  });assert.ok(inkColor&&new Set(inkColor).size>1,'signal color reaches actual ink');
  const painted=await page.locator('#tracingCanvas').evaluate(c=>c.toDataURL());
  mode='base';await page.waitForTimeout(1500);
  assert.equal(await page.locator('#tracingCanvas').evaluate(c=>c.toDataURL()),painted,'old ink remains immutable');
  await page.uncheck('#mappingEnabled');await stroke(.5);
  const pending=page.waitForEvent('download');await page.click('#downloadInput');const downloaded=await pending;
  const streamData=await downloaded.createReadStream(),chunks=[];for await(const c of streamData)chunks.push(c);
  const data=JSON.parse(Buffer.concat(chunks));assert.equal(data.schemaVersion,2);assert.ok(data.segments.some(s=>s.brush?.mappingVersion));
  assert.ok(data.samples.some(s=>Math.abs(s.pressure-.73)<1e-6),'actual reported pressure preserved');
  assert.ok(data.configurationHistory.some(h=>h.value.enabled===false));
  const replayed=await page.evaluate(data=>{
    const c=document.createElement('canvas');c.width=data.canvas.width;c.height=data.canvas.height;BrushRenderer.replay(c.getContext('2d'),data);
    return c.toDataURL()===document.getElementById('tracingCanvas').toDataURL();
  },data);assert.equal(replayed,true,'exported snapshots replay exact ink');
  const pngPending=page.waitForEvent('download');await page.click('#downloadTracing');const png=await pngPending;
  const pngStream=await png.createReadStream(),pngChunks=[];for await(const c of pngStream)pngChunks.push(c);
  const buffer=Buffer.concat(pngChunks);assert.equal(buffer.readUInt32BE(16),600);assert.equal(buffer.readUInt32BE(20),800);
  const out=path.join(__dirname,'../diagnostics/mirror');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'synthetic-data-brush.png'),buffer);
  await page.locator('.pen-panel').screenshot({path:path.join(out,'data-brush-panel.png')});
  connected=false;await page.check('#mappingEnabled');await page.waitForFunction(()=>!MirrorSensors.mapping.connected);
  assert.equal(await page.evaluate(()=>MirrorSensors.mapping.target().width),2);await stroke(.7);
  const waiting=await page.locator('#tracingCanvas').evaluate(c=>c.toDataURL());assert.notEqual(waiting,painted);
  stream='restarted';connected=true;await page.waitForFunction(()=>MirrorSensors.mapping.streamId==='restarted');
  assert.ok(Object.values(await page.evaluate(()=>MirrorSensors.mapping.references())).every(x=>x===null));
  await page.evaluate(()=>MirrorSensors.newPhoto());assert.equal(await page.evaluate(()=>MirrorSensors.mapping.channels.left.points.length),0);
  assert.deepEqual(errors,[]);console.log('Four-channel synthetic mapping, calibration, unchanged ink, disconnect, restart, raw pressure, v2 replay and PNG export passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
