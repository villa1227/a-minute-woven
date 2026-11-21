const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{
 const context=await b.newContext(),p=await context.newPage();let recording=true,fail=false,stops=0;
 await context.route('**/api/sensors*',r=>r.fulfill({json:{connected:true,state:{recording,artwork_running:false,cameras:[],devices:[],eda_ports:[],eda:{connected:false},expression:{running:false}},trace:{stream_id:'test',cursor:10,now_s:0,rows:[]}}}));
 await context.route('**/api/device/record_stop',r=>{stops++;if(!fail)recording=false;return r.fulfill({status:fail?400:200,json:fail?{error:'disk failure'}:{ok:true}});});
 for(const route of ['/background']){
   recording=true;fail=true;await p.goto('http://127.0.0.1:8767'+route);
   await p.evaluate(()=>{localStorage.setItem('cyber-mirror.line-preset.v1',JSON.stringify({detail:'standard',lineWidth:3,tuning:{sigma:1.8}}));document.getElementById('photoCanvas').dataset.participant='old';});
   await p.click('#nextParticipant');await p.waitForFunction(()=>!document.getElementById('nextParticipant').disabled);
   assert.match(await p.locator('#participantStatus').textContent(),/disk failure/);
   assert.equal(await p.locator('#photoCanvas').getAttribute('data-participant'),'old','do not erase work if stop fails');
   fail=false;await Promise.all([p.waitForEvent('load'),p.click('#nextParticipant')]);
   assert.equal(await p.locator('#photoCanvas').getAttribute('data-participant'),null);
   assert.equal(await p.locator('#sigmaNumber').inputValue(),'1.8','keep saved settings');
   assert.equal(await p.locator('#photoCanvas').isVisible(),false);
   assert.equal(await p.locator('#downloadInput').isDisabled(),true);
   if(route==='/background'){assert.equal(await p.locator('#wovenEnabled').isChecked(),false);assert.equal(await p.evaluate(()=>MirrorWoven.export().artwork),null);}
 }
 assert.equal(stops,2);console.log('Final-edition participant refresh clears private state, keeps presets, stops recording and retains work on failure.');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
