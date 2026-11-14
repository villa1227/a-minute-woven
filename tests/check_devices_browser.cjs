// Synthetic collector only: never start/stop the user's actual devices.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[],commands=[];
  page.on('pageerror',error=>errors.push(error.message));
  const state={cameras:[{index:0,name:'Test camera'}],devices:[],eda_ports:[{port:'COM6',description:'USB test'}],
    camera_alive:false,camera_fresh:false,heart_alive:false,heart_fresh:false,scanning:false,recording:false,artwork_running:false,
    expression:{running:false,fresh:false},eda:{connected:false,status:'未连接'},messages:{camera:'test',heart:'test'},counts:{}};
  await page.route('**/api/sensors*',route=>route.fulfill({json:{connected:true,mode:'integrated',state,trace:{stream_id:'test',now_s:performance.now()/1000,cursor:0,rows:[]}}}));
  await page.route('**/api/device-frame',route=>route.fulfill({status:204}));
  await page.route('**/api/device/*',route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1),data=route.request().postDataJSON();commands.push({name,data});
    if(name==='camera_start'){state.camera_alive=state.camera_fresh=true;state.messages.camera='已开启';}
    if(name==='camera_stop'){state.camera_alive=state.camera_fresh=false;state.expression.running=false;}
    if(name==='expression_start')state.expression.running=true;
    if(name==='expression_stop')state.expression.running=false;
    if(name==='scan')state.devices=[{address:'test-address',name:'test Band'}];
    if(name==='heart_connect')state.heart_alive=true;
    if(name==='heart_stop')state.heart_alive=false;
    if(name==='eda_connect')state.eda.connected=true;
    if(name==='eda_stop')state.eda.connected=false;
    if(name==='record_start')state.recording=true;
    if(name==='record_stop')state.recording=false;
    return route.fulfill({json:{ok:true}});
  });
  await page.goto('http://127.0.0.1:8767/');
  await page.waitForFunction(()=>!document.getElementById('sensorCameraStart').disabled);
  await page.click('#sensorCameraStart');await page.waitForFunction(()=>!document.getElementById('sensorExpressionStart').disabled);
  await page.click('#sensorExpressionStart');await page.waitForFunction(()=>!document.getElementById('sensorExpressionStop').disabled);
  await page.click('#sensorHeartScan');await page.waitForFunction(()=>!document.getElementById('sensorHeartConnect').disabled);
  await page.click('#sensorHeartConnect');await page.waitForFunction(()=>!document.getElementById('sensorHeartStop').disabled);
  await page.click('#sensorEdaConnect');await page.waitForFunction(()=>!document.getElementById('sensorEdaStop').disabled);
  await page.click('#sensorRecord');await page.waitForFunction(()=>document.getElementById('sensorRecord').textContent.includes('停止'));
  const blocked=await page.evaluate(async()=>{try{await MirrorDevices.beforePhoto();return false;}catch(error){return error.message;}});
  assert.match(blocked,/停止记录/);assert.ok(!commands.some(c=>c.name==='camera_stop'),'recording must not be interrupted for photo');
  await page.click('#sensorRecord');await page.waitForFunction(()=>document.getElementById('sensorRecord').textContent.includes('开始'));
  await page.evaluate(()=>MirrorDevices.beforePhoto());
  assert.equal(commands.at(-1).name,'camera_stop');
  assert.equal(await page.locator('#sensorCameraStart').isDisabled(),true,'browser photo mode locks acquisition');
  await page.evaluate(()=>MirrorDevices.photoEnded());await page.waitForFunction(()=>!document.getElementById('sensorCameraStart').disabled);
  assert.equal(await page.locator('#feedbackStrength').inputValue(),'3');
  await page.locator('#feedbackStrength').evaluate(e=>{e.value='5';e.dispatchEvent(new Event('input'));});
  assert.equal(await page.evaluate(()=>MirrorSensors.mapping.intensity),5);
  assert.match(await page.locator('#feedbackStrengthValue').textContent(),/强烈/);
  // Same real scalar change, same path: compare mild vs amplified visual footprint.
  const visual=await page.evaluate(()=>{
    const values={};const map=new BioBrush.BrushMapping(()=>0);
    map.connected=true;map.serverNow=0;map.received=0;
    for(const [key,v,ref] of [['left',20.8,20],['heart',75,70],['eda',515,500]]){
      map.channels[key]={latest:{t:0,value:v},points:[{t:0,value:v}],ref};
    }
    const metrics=[];const board=document.createElement('canvas');board.width=600;board.height=170;
    const context=board.getContext('2d');context.fillStyle='white';context.fillRect(0,0,600,170);
    for(const [i,intensity] of [1,3,5].entries()){
      map.intensity=intensity;const b=map.target(),layer=document.createElement('canvas');layer.width=600;layer.height=50;
      const renderer=new BrushRenderer(layer.getContext('2d'),'compare');
      for(let x=30;x<570;x+=3)renderer.draw({x,y:25,strokeId:1,eventTimeMs:x*8,contact:true,outside:false},b);
      const p=layer.getContext('2d').getImageData(0,0,600,50).data;
      let footprint=0;for(let j=3;j<p.length;j+=4)if(p[j]>15)footprint++;
      context.drawImage(layer,0,i*55);metrics.push({intensity,width:b.width,wobble:b.wobble,softness:b.softness,footprint});
    }
    return {metrics,png:board.toDataURL().split(',')[1]};
  });
  assert.ok(visual.metrics[1].footprint>visual.metrics[0].footprint*2,'default stronger feedback is visibly wider');
  const fs=require('node:fs'),path=require('node:path'),out=path.join(__dirname,'../diagnostics/mirror');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'feedback-strength-comparison.png'),Buffer.from(visual.png,'base64'));
  await page.screenshot({path:path.join(out,'integrated-devices.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'integrated-devices-mobile.png'),fullPage:true});
  assert.deepEqual(commands.find(c=>c.name==='camera_start').data,{index:0,rate:20,save_frames:false});
  assert.equal(commands.find(c=>c.name==='eda_connect').data.port,'COM6');
  assert.deepEqual(errors,[]);console.log('Integrated device controls, photo handoff, recording guard, strength slider and visual comparison passed:',visual.metrics);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
