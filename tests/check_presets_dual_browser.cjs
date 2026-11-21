const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const context=await browser.newContext({viewport:{width:1280,height:1100}}),page=await context.newPage(),errors=[],commands=[];
  page.on('pageerror',e=>errors.push(e.message));
  const state={cameras:[{index:0,name:'eyes'},{index:1,name:'face'}],camera_alive:false,camera_fresh:false,heart_alive:false,devices:[],eda_ports:[],
    face_camera_alive:false,expression:{running:false,fresh:false},eda:{connected:false},messages:{},counts:{}};
  await context.route('**/api/sensors*',r=>r.fulfill({json:{connected:true,state,trace:{stream_id:'test',now_s:0,cursor:0,rows:[]}}}));
  await context.route('**/api/device-frame*',r=>r.fulfill({status:204}));
  await context.route('**/api/device/*',r=>{commands.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});});
  await page.goto('http://127.0.0.1:8767/background');
  assert.equal(await page.locator('#sigmaNumber').inputValue(),'1.5');assert.equal(await page.locator('#percentileNumber').inputValue(),'0.85');
  assert.equal(await page.locator('#lineWidth').inputValue(),'3');
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=300;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,240,300);x.fillStyle='black';x.fillRect(50,40,130,180);return c.toDataURL().split(',')[1];});
  await page.locator('#photoFile').setInputFiles({name:'shape.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>!document.getElementById('confirm').hidden);await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
  await page.locator('#sigmaNumber').fill('1.8');await page.waitForFunction(()=>!document.getElementById('download').disabled);
  await page.click('#saveLinePreset');assert.match(await page.locator('#savedPresetStatus').textContent(),/已保存/);
  await page.reload();await page.waitForFunction(()=>window.MirrorLinePreset);
  assert.equal(await page.locator('#sigmaNumber').inputValue(),'1.8');assert.equal(await page.locator('#lineWidth').inputValue(),'3');
  const old=await context.newPage();await old.goto('http://127.0.0.1:8767/');assert.equal(await old.locator('#sigmaNumber').inputValue(),'1.8');
  assert.equal(await old.locator('#lineWidth').inputValue(),'3');
  await page.selectOption('#sensorFaceCamera','1');await page.waitForFunction(()=>!document.getElementById('sensorExpressionStart').disabled);
  await page.click('#sensorExpressionStart');assert.deepEqual(commands.at(-1),{rate:5,camera_index:1});
  const ink=await page.evaluate(()=>{
    const p={...BioBrush.BASE,width:9.5,opacity:.85,softness:0};const faded=BackgroundBrush.adapt(p,{longestSide:1000,eyeActive:true});
    return {opacity:faded.opacity,width:faded.width};
  });assert.ok(ink.opacity<.4);assert.equal(ink.width,60);
  await page.evaluate(()=>localStorage.setItem('cyber-mirror.line-preset.v1','{"detail":"invalid"}'));await page.reload();
  assert.equal(await page.locator('#sigmaNumber').inputValue(),'1.5','invalid stored preset falls back');
  assert.deepEqual(errors,[]);console.log('Screenshot defaults, thicker guide, preset persistence, independent face selector and pale brush passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
