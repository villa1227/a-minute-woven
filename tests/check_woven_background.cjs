const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const p=await browser.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:8767/background');
  await p.evaluate(()=>{
    const c=document.getElementById('lineCanvas');c.width=400;c.height=500;c.hidden=false;
    const x=c.getContext('2d');x.strokeStyle='black';x.lineWidth=3;x.strokeRect(60,60,280,380);MirrorTracing.enable(400,500,'woven-test');
  });
  assert.equal(await p.locator('#wovenEnabled').isChecked(),false);
  const before=await p.evaluate(()=>MirrorBackgroundComposition.compose(true).toDataURL());
  await p.check('#wovenEnabled');await p.waitForTimeout(5500);
  await p.waitForFunction(()=>MirrorWoven.export().artwork.bands.length>=1);
  const first=await p.evaluate(()=>MirrorWoven.export());assert.equal(first.included,true);assert.equal(first.artwork.bands.length,1);
  const ink=await p.locator('#backgroundCanvas').evaluate(c=>c.toDataURL());
  const on=await p.evaluate(()=>MirrorBackgroundComposition.compose(true).toDataURL());assert.notEqual(on,before);
  await p.uncheck('#wovenEnabled');const off=await p.evaluate(()=>MirrorBackgroundComposition.compose(true).toDataURL());assert.equal(off,before);
  await p.check('#wovenEnabled');assert.equal(await p.evaluate(()=>MirrorWoven.export().artwork.seed),'woven-test');
  assert.equal(await p.locator('#backgroundCanvas').evaluate(c=>c.toDataURL()),ink);
  await p.click('#clearTracing');assert.ok(await p.evaluate(()=>MirrorWoven.export().artwork.bands.length>=1));
  await p.evaluate(()=>MirrorTracing.disable());assert.equal(await p.evaluate(()=>MirrorWoven.export().artwork),null);
  assert.deepEqual(errors,[]);console.log('Woven toggle, growth, export composition, preserved paint, clear and reset passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
