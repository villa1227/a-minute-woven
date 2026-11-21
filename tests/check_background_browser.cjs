// Background edition QA: synthetic sensor/pen data, no hardware commands.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'diagnostics/mirror');fs.mkdirSync(out,{recursive:true});
const fixture=JSON.parse(fs.readFileSync(path.join(root,'examples/brush.synthetic.json'),'utf8'));
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const context=await browser.newContext({viewport:{width:1320,height:1200}}),errors=[];
  context.setDefaultTimeout(15000);
  let seq=0,t=0,connected=true;
  await context.route('**/api/sensors*',async route=>{
    const rows=[],time=t;t+=.05;
    const push=(source,data)=>rows.push({source,data,t:time,seq:++seq});
    push('camera',{eyes:{image_left:{quality:'candidate_unvalidated',candidate_diameter_px:20},image_right:{quality:'candidate_unvalidated',candidate_diameter_px:24}}});
    push('heart_rate',{bpm:72});for(let i=0;i<4;i++)push('eda',{adc:500,segment:0,stream_id:'gsr',quality:'received_unvalidated'});
    push('expression',fixture.expression);
    const reset=!new URL(route.request().url()).searchParams.has('after');
    await route.fulfill({json:{connected,reset,mode:'integrated',state:fixture.state,trace:connected?{stream_id:'same-backend',now_s:t,cursor:seq,rows:reset?[]:rows}:null}});
  });
  await context.route('**/api/device-frame',route=>route.fulfill({status:204}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8767/background');
  assert.equal(await page.locator('.version-nav a[href="/"]').getAttribute('target'),'_blank');
  const photo=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=400;c.height=500;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,400,500);x.strokeStyle='black';x.lineWidth=5;x.strokeRect(70,80,260,340);x.beginPath();x.ellipse(200,220,70,100,0,0,Math.PI*2);x.stroke();return c.toDataURL().split(',')[1];});
  async function importImage(p=page){
    await p.locator('#photoFile').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
    await p.waitForFunction(()=>!document.getElementById('confirm').hidden);await p.click('#confirm');await p.waitForFunction(()=>!document.getElementById('download').disabled);
  }
  await importImage();
  await page.locator('.advanced-art').evaluate(e=>e.open=true);
  console.log('Background check: initial image ready');
  assert.equal(await page.locator('#backgroundDiameter').inputValue(),'6');
  assert.equal(await page.locator('#backgroundCanvas').evaluate(c=>c.width),400);
  const lineBefore=await page.locator('#lineCanvas').evaluate(c=>c.toDataURL());
  const transparent=await page.locator('#lineCanvas').evaluate(c=>c.getContext('2d').getImageData(0,0,1,1).data[3]);assert.equal(transparent,0);
  const legacy=await context.newPage();legacy.on('pageerror',e=>errors.push(e.message));await legacy.goto('http://127.0.0.1:8767/');await importImage(legacy);
  assert.equal(await legacy.locator('#backgroundCanvas').count(),0);
  assert.equal(await legacy.locator('#lineCanvas').evaluate(c=>c.getContext('2d').getImageData(0,0,1,1).data[3]),255,'old edition still has white opaque guide');
  await page.waitForFunction(()=>MirrorSensors.mapping.channels.eda.points.length>=20);await page.click('#setBrushReference');
  assert.equal(await page.evaluate(()=>MirrorSensors.mapping.references().left),20);
  assert.equal(await legacy.evaluate(()=>MirrorSensors.mapping.references().left),null,'per-tab references are independent');
  assert.equal(await legacy.evaluate(()=>MirrorSensors.mapping.streamId),await page.evaluate(()=>MirrorSensors.mapping.streamId));
  fixture.state.heart_alive=false;
  await page.waitForFunction(()=>MirrorSensors.mapping.state.heart_alive===false);
  await legacy.waitForFunction(()=>MirrorSensors.mapping.state.heart_alive===false);
  assert.equal(await legacy.evaluate(()=>MirrorSensors.mapping.value('heart')),null);
  assert.equal(await page.evaluate(()=>MirrorSensors.mapping.value('heart')),null,'device state changes propagate to both versions');
  fixture.state.heart_alive=true;
  await page.locator('#backgroundDiameter').evaluate(e=>{e.value='16';e.dispatchEvent(new Event('input'));});
  async function stroke(p,y){await p.locator('#tracingCanvas').evaluate((c,y)=>{const r=c.getBoundingClientRect();
    for(let i=0;i<=24;i++)c.dispatchEvent(new PointerEvent(i?'pointermove':'pointerdown',{bubbles:true,pointerType:'pen',pointerId:90,isPrimary:true,
      clientX:r.left+r.width*(.05+.9*i/24),clientY:r.top+r.height*y,button:i?-1:0,buttons:1,pressure:.67}));
    c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'pen',pointerId:90,isPrimary:true,buttons:0,pressure:0,clientX:r.left+r.width*.95,clientY:r.top+r.height*y}));
  },y);}
  for(const y of [.17,.36,.55,.74]){await stroke(page,y);await stroke(legacy,y);}
  assert.equal(await page.locator('#lineCanvas').evaluate(c=>c.toDataURL()),lineBefore,'ink cannot rewrite line layer');
  const layers=await page.evaluate(()=>{
    const line=document.getElementById('lineCanvas'),paint=document.getElementById('backgroundCanvas'),input=document.getElementById('tracingCanvas');
    const l=line.getContext('2d').getImageData(0,0,400,500).data,p=paint.getContext('2d').getImageData(0,0,400,500).data;
    const c=MirrorBackgroundComposition.compose(true),pixels=c.getContext('2d').getImageData(0,0,400,500).data;
    let intersection=0,coloredGap=0;for(let i=0;i<l.length;i+=4){
      if(l[i+3]===255&&p[i+3]>30){intersection++;if(pixels[i]!==0||pixels[i+1]!==0||pixels[i+2]!==0)throw Error('line covered by paint');}
      if(l[i+3]===0&&p[i+3]>50&&pixels[i]<250)coloredGap++;
    }
    const inputPixels=input.getContext('2d').getImageData(0,0,400,500).data;
    return {intersection,coloredGap,inputEmpty:inputPixels.every(v=>v===0),order:[paint,line,input].map(c=>Number(getComputedStyle(c).zIndex))};
  });assert.ok(layers.intersection>100&&layers.coloredGap>1000);assert.ok(layers.inputEmpty);assert.deepEqual(layers.order,[1,2,3]);
  await page.click('#toggleGuide');assert.equal(await page.locator('#lineCanvas').evaluate(c=>c.style.opacity),'0');
  assert.ok(await page.locator('#backgroundCanvas').isVisible());
  async function download(id){const pending=page.waitForEvent('download');await page.click(id);const d=await pending,s=await d.createReadStream(),chunks=[];for await(const c of s)chunks.push(c);return Buffer.concat(chunks);}
  const input=JSON.parse(await download('#downloadInput'));
  assert.equal(input.schemaVersion,2);assert.equal(input.frontendVersion,'background-v1');assert.equal(input.diameterPercent,16);assert.equal(input.baseDiameter,80);
  assert.ok(input.samples.some(s=>Math.abs(s.pressure-.67)<1e-6));assert.ok(input.segments.some(s=>s.brush?.width>=40&&s.brush?.baseDiameter===80));
  const replay=await page.evaluate(data=>{const c=document.createElement('canvas');c.width=data.canvas.width;c.height=data.canvas.height;
    BackgroundBrush.BackgroundBrushRenderer.replay(c.getContext('2d'),data);return c.toDataURL()===document.getElementById('backgroundCanvas').toDataURL();},input);assert.equal(replay,true);
  const artwork=await download('#downloadArtwork'),background=await download('#downloadTracing'),guide=await download('#download');
  for(const png of [artwork,background,guide])assert.equal(png.readUInt32BE(16),400);
  assert.equal(artwork.readUInt32BE(20),564);assert.equal(background.readUInt32BE(20),500);assert.equal(guide.readUInt32BE(20),500);
  assert.notDeepEqual(artwork,background,'artwork includes black lines even when guide hidden');
  const saved=await page.locator('#backgroundCanvas').evaluate(c=>c.toDataURL());
  console.log('Background check: input replay and downloads ready');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
  const aligned=await page.evaluate(()=>{const ids=['lineCanvas','backgroundCanvas','tracingCanvas'],rects=ids.map(id=>document.getElementById(id).getBoundingClientRect());return rects.every(r=>Math.abs(r.width-rects[0].width)<1&&Math.abs(r.height-rects[0].height)<1&&Math.abs(r.left-rects[0].left)<1&&Math.abs(r.top-rects[0].top)<1)&&document.documentElement.scrollWidth<=innerWidth;});assert.ok(aligned);
  assert.equal(await page.locator('#backgroundCanvas').evaluate(c=>c.toDataURL()),saved);
  connected=false;await page.waitForFunction(()=>!MirrorSensors.mapping.connected);
  assert.equal(await page.evaluate(()=>MirrorBackground.adapt(MirrorSensors.brush()).width),80,'missing eyes use full base diameter');
  await page.uncheck('#mappingEnabled');await stroke(page,.9);
  const off=await page.evaluate(()=>MirrorBackground.adapt(MirrorSensors.brush()));assert.deepEqual(off.color,[54,61,62]);assert.equal(off.width,80);assert.equal(off.wobble,0);
  const legacyImage=await legacy.locator('#tracingCanvas').evaluate(c=>c.toDataURL());await page.click('#clearTracing');
  assert.equal(await page.locator('#downloadInput').isDisabled(),true);assert.equal(await page.locator('#lineCanvas').evaluate(c=>c.toDataURL()),lineBefore);
  assert.equal(await legacy.locator('#tracingCanvas').evaluate(c=>c.toDataURL()),legacyImage,'clear does not affect another edition');
  await stroke(page,.4);await page.locator('input[value="minimal"]').check();await page.waitForFunction(()=>!document.getElementById('download').disabled);
  assert.equal(await page.locator('#downloadInput').isDisabled(),true,'regeneration resets paint/input');
  // Max-size workload, cached broad strokes, exact deterministic replay.
  const perf=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=c.height=1600;
    const b=BackgroundBrush.adapt({...BioBrush.BASE,color:[180,90,70],width:28,softness:7.5,hardness:.2,textureStrength:5,family:'grain',wobble:10.4,frequency:1.5},{longestSide:1600,diameterPercent:16,eyeActive:true});
    const renderer=new BackgroundBrush.BackgroundBrushRenderer(c.getContext('2d'),'performance'),times=[],samples=[],segments=[];
    for(let i=0;i<240;i++){
      const s={x:150+i*5,y:800+Math.sin(i/15)*200,eventTimeMs:i*5,strokeId:1,contact:true,outside:false};
      const t=performance.now();renderer.draw(s,b);times.push(performance.now()-t);samples.push(s);segments.push({kind:'sample',sampleIndex:i,brush:b});
    }
    const d=document.createElement('canvas');d.width=d.height=1600;
    BackgroundBrush.BackgroundBrushRenderer.replay(d.getContext('2d'),{schemaVersion:2,renderer:BackgroundBrush.VERSION,renderSeed:'performance',samples,segments});
    times.sort((a,b)=>a-b);return {p95_ms:times[228],max_ms:times.at(-1),cacheBuilds:renderer.cacheBuilds,diameter:b.width,replay:c.toDataURL()===d.toDataURL()};
  });assert.equal(perf.cacheBuilds,1);assert.equal(perf.diameter,512);assert.ok(perf.replay);
  console.log('Background check: maximum-size rendering ready');
  // Public portrait QA; file is optional and ignored by Git.
  connected=true;const portrait=path.join(out,'grace_hopper.jpg');
  if(fs.existsSync(portrait)){
    await page.setViewportSize({width:1320,height:1200});await page.locator('#photoFile').setInputFiles(portrait);
    await page.waitForFunction(()=>!document.getElementById('confirm').hidden);await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
    await page.check('#mappingEnabled');await page.waitForFunction(()=>MirrorSensors.mapping.connected);
    await page.locator('input[value="standard"]').check();await page.waitForFunction(()=>!document.getElementById('download').disabled);
    await page.locator('#backgroundDiameter').evaluate(e=>{e.value='6';e.dispatchEvent(new Event('input'));});
    await page.waitForFunction(()=>MirrorSensors.mapping.brush().color[0]>150);
    for(const y of [.12,.3,.48,.66,.84])await stroke(page,y);
    await legacy.locator('#photoFile').setInputFiles(portrait);await legacy.waitForFunction(()=>!document.getElementById('confirm').hidden);await legacy.click('#confirm');await legacy.waitForFunction(()=>!document.getElementById('download').disabled);
    await legacy.waitForFunction(()=>MirrorSensors.mapping.brush().color[0]>150);
    for(const y of [.12,.3,.48,.66,.84])await stroke(legacy,y);
    fs.writeFileSync(path.join(out,'background-portrait-artwork.png'),await download('#downloadArtwork'));
    const legacyPNG=await legacy.evaluate(()=>{const source=document.getElementById('lineCanvas'),paint=document.getElementById('tracingCanvas'),c=document.createElement('canvas');c.width=source.width;c.height=source.height;const x=c.getContext('2d');x.drawImage(source,0,0);x.drawImage(paint,0,0);return c.toDataURL().split(',')[1];});
    fs.writeFileSync(path.join(out,'legacy-portrait-comparison.png'),Buffer.from(legacyPNG,'base64'));
    await page.screenshot({path:path.join(out,'background-page.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'background-mobile.png'),fullPage:true});
  }
  fs.writeFileSync(path.join(out,'background-synthetic-artwork.png'),artwork);
  console.log('Background check: portrait comparison ready');
  // Exercise the independent photo app with a simulated browser camera.
  await context.route('**/api/device/*',route=>{
    const command=new URL(route.request().url()).pathname;
    assert.ok(['/api/device/camera_stop','/api/device/expression_stop'].includes(command));
    if(command.endsWith('expression_stop')){fixture.state.expression.running=false;fixture.state.face_camera_alive=false;}
    else {fixture.state.camera_alive=false;fixture.state.camera_fresh=false;}
    return route.fulfill({json:{ok:true}});
  });
  await page.evaluate(()=>{
    window.__backgroundCameraStops=0;
    Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[],addEventListener:()=>{},getUserMedia:async()=>{
      const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');
      const paint=()=>{x.fillStyle='red';x.fillRect(0,0,160,240);x.fillStyle='blue';x.fillRect(160,0,160,240);};
      paint();const stream=c.captureStream(20),track=stream.getVideoTracks()[0],stop=track.stop.bind(track),timer=setInterval(paint,50);
      track.stop=()=>{window.__backgroundCameraStops++;clearInterval(timer);stop();};return stream;
    }}});
  });
  await page.click('#openCamera');await page.waitForFunction(()=>!document.getElementById('capture').disabled);
  await page.click('#capture');assert.equal(await page.evaluate(()=>window.__backgroundCameraStops),1);
  assert.equal(await page.locator('#backgroundCanvas').isVisible(),false);
  const mirrored=await page.locator('#photoCanvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(5,5,1,1).data));
  assert.ok(mirrored[2]>mirrored[0]);await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
  assert.equal(await page.locator('#lineCanvas').evaluate(c=>c.getContext('2d').getImageData(0,0,1,1).data[3]),0);
  assert.deepEqual(errors,[]);console.log('Background edition checks passed:',JSON.stringify({layers,perf,portraitChecked:fs.existsSync(portrait)}));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
