// Optional UI check with synthetic API responses; never opens hardware.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const errors=[];page.on('pageerror', e=>errors.push(e.message));
    const samples=JSON.parse(fs.readFileSync(path.join(root,'examples/expression.synthetic.json'),'utf8')).rows;
    const commands=[];
    const state={cameras:[],devices:[],messages:{camera:'test',heart:'test'},camera_alive:true,
      camera_fresh:false,heart_alive:false,heart_fresh:false,recording:false,artwork_running:false,counts:{expression:3},
      expression:{running:false,state:'stopped',target_hz:5,fresh:false,age_s:null,sample:null,error:null}};
    await page.route('http://127.0.0.1:9876/**', async route=>{
      const request=route.request(), url=new URL(request.url());
      let body, contentType='application/json';
      if(url.pathname==='/api/state') body=JSON.stringify(state);
      else if(url.pathname==='/api/trace') body=JSON.stringify({stream_id:'test',cursor:0,now_s:0,rows:[]});
      else if(url.pathname==='/api/artwork') body=JSON.stringify({status:'idle',bands:[]});
      else if(url.pathname==='/api/frame') return route.fulfill({status:204});
      else if(request.method()==='POST') {
        commands.push([url.pathname,request.postDataJSON()]);
        if(url.pathname==='/api/expression_start') Object.assign(state.expression,{running:true,state:'running',fresh:true,age_s:.04,sample:samples[0].data});
        else if(url.pathname==='/api/expression_stop') Object.assign(state.expression,{running:false,state:'stopped',fresh:false,sample:null});
        body='{"ok":true}';
      } else {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        assert.ok(/^[a-z-]+\.(html|js)$/.test(file));
        contentType=file.endsWith('.js')?'text/javascript':'text/html';
        body=fs.readFileSync(path.join(root,'web',file),'utf8').replace('__API_TOKEN__','synthetic-test');
      }
      return route.fulfill({body,contentType});
    });
    await page.goto('http://127.0.0.1:9876/');
    await page.locator('#devicePanel').evaluate(e=>e.open=true);
    await page.waitForFunction(()=>window.ExpressionPanel);
    const before=await page.locator('#artCanvas').evaluate(c=>c.toDataURL());
    await page.click('#expressionStart');
    await page.waitForFunction(()=>document.getElementById('expressionLabel').textContent==='高兴');
    assert.equal(await page.locator('#expressionBars meter').count(),7);
    assert.equal(await page.locator('#expressionBars meter').nth(3).evaluate(e=>e.value),.72);
    assert.deepEqual(commands[0],['/api/expression_start',{rate:5}]);
    assert.equal(await page.locator('#artCanvas').evaluate(c=>c.toDataURL()),before,'expression must not alter artwork');
    for(const sample of [samples[1].data,samples[2].data]) {
      state.expression.sample=sample;await page.evaluate(()=>update());
      assert.equal(await page.locator('#expressionLabel').innerText(),'—');
      assert.equal(await page.locator('#expressionBars meter').nth(3).evaluate(e=>e.value),0);
    }
    state.expression.sample=samples[0].data;state.expression.fresh=false;
    await page.evaluate(()=>update());
    assert.equal(await page.locator('#expressionLabel').textContent(),'—');
    await page.click('#expressionStop');
    assert.deepEqual(commands[1],['/api/expression_stop',{}]);
    await page.reload(); await page.waitForFunction(()=>window.ExpressionPanel);
    await page.evaluate(()=>update());
    assert.equal(await page.locator('#expressionLabel').textContent(),'—');
    assert.deepEqual(errors,[]);
    console.log('Expression controls, seven scores, missing/stale data, refresh, and unchanged artwork passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
