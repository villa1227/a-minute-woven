const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8767/');
  await page.evaluate(()=>{
    const line=document.getElementById('lineCanvas');line.width=600;line.height=800;line.hidden=false;
    line.getContext('2d').fillStyle='white';line.getContext('2d').fillRect(0,0,600,800);
    MirrorTracing.enable(600,800,'synthetic-test');
  });
  await page.locator('#tracingCanvas').scrollIntoViewIfNeeded();
  async function emit(type,x,y,extra={}){await page.locator('#tracingCanvas').evaluate((c,{type,x,y,extra})=>{
    const r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'pen',pointerId:123,isPrimary:true,
      clientX:r.left+x*r.width,clientY:r.top+y*r.height,buttons:1,button:type==='pointerdown'?0:-1,pressure:.4,tiltX:10,...extra}));
  },{type,x,y,extra});}
  await emit('pointerdown',.2,.2);await emit('pointermove',.3,.3);await emit('pointermove',1.2,.3);await emit('pointermove',.7,.7);
  await emit('pointerup',.7,.7,{buttons:0,pressure:0});
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#penType').innerText(),'笔输入');
  const alpha=await page.locator('#tracingCanvas').evaluate(c=>({line:c.getContext('2d').getImageData(150,200,1,1).data[3],gap:c.getContext('2d').getImageData(300,400,1,1).data[3]}));
  assert.ok(alpha.line>0);assert.equal(alpha.gap,0,'no bridge after re-entry');
  await page.click('#toggleGuide');assert.equal(await page.locator('#lineCanvas').evaluate(c=>c.style.opacity),'0');
  assert.equal(await page.locator('#tracingCanvas').isVisible(),true);
  const pending=page.waitForEvent('download');await page.click('#downloadInput');const download=await pending;
  const stream=await download.createReadStream(),chunks=[];for await(const c of stream)chunks.push(c);
  const data=JSON.parse(Buffer.concat(chunks).toString());assert.equal(data.samples.length,5);assert.ok(Math.abs(data.samples[0].pressure-.4)<1e-6);
  assert.equal(data.sessionId,'synthetic-test');
  await page.setViewportSize({width:800,height:1000});
  const aligned=await page.evaluate(()=>{const a=document.getElementById('lineCanvas').getBoundingClientRect(),b=document.getElementById('tracingCanvas').getBoundingClientRect();return Math.abs(a.left-b.left)+Math.abs(a.top-b.top)+Math.abs(a.width-b.width)+Math.abs(a.height-b.height);});assert.ok(aligned<2);
  await emit('pointerdown',.1,.1);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await emit('pointermove',.9,.9);
  await page.click('#clearTracing');assert.equal(await page.locator('#downloadInput').isDisabled(),true);
  await emit('pointerdown',.2,.2);await emit('pointercancel',.3,.3,{buttons:0});await emit('pointermove',.4,.4);
  const afterCancel=await page.evaluate(()=>{
    const c=document.getElementById('tracingCanvas');return c.getContext('2d').getImageData(240,320,1,1).data[3];
  });assert.equal(afterCancel,0);
  // A real browser mouse path is explicitly reported as fallback.
  await page.click('#clearTracing');
  await page.locator('#tracingCanvas').scrollIntoViewIfNeeded();
  const bounds=await page.locator('#tracingCanvas').boundingBox();
  await page.mouse.move(bounds.x+bounds.width*.3,bounds.y+bounds.height*.3);await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width*.4,bounds.y+bounds.height*.4);await page.mouse.up();
  await page.waitForTimeout(150);assert.equal(await page.locator('#penType').innerText(),'鼠标回退');
  assert.match(await page.locator('#penPressure').innerText(),/不作为笔压/);
  await page.evaluate(()=>MirrorTracing.enable(600,800,'regenerated'));
  assert.equal(await page.locator('#downloadInput').isDisabled(),true,'regeneration clears all samples');
  await page.evaluate(()=>MirrorTracing.disable());assert.equal(await page.locator('#tracingCanvas').isVisible(),false);
  assert.deepEqual(errors,[]);console.log('Pen overlay, coordinates, re-entry, JSON, visibility, resize, clear and interruption passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
