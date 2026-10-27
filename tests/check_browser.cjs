// Optional integration check: running server on 8765, Playwright with Edge installed.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/');
    await page.waitForTimeout(800);
    const cameras = await page.locator('#camera option').allTextContents();
    console.log('Camera devices:', cameras);
    await page.click('#artStart');
    await page.waitForTimeout(2500);
    assert.match(await page.locator('#artStatus').innerText(), /准备/);
    assert.equal(await page.locator('#artBands').innerText(), '0 / 12');
    await page.waitForTimeout(4800);
    const image1 = await page.locator('#artCanvas').evaluate(c => c.toDataURL());
    await page.waitForTimeout(200);
    const image2 = await page.locator('#artCanvas').evaluate(c => c.toDataURL());
    assert.notEqual(image1, image2, 'growth between data polls');
    await page.reload(); await page.waitForTimeout(300);
    assert.equal(await page.locator('#artHint').isVisible(), false);
    await page.click('#artCancel');
    assert.equal(await page.locator('#artDownload').isVisible(), false);
    const result = await page.evaluate(() => {
      const band = {index: 0, seed: 'bench:0', values: {left: 20,right: 20,heart: 80}, amplitude: {left: .2,right:.2}, threads:40, base_threads:22, empty:false};
      const artwork = {id:'bench',schema_version:2,status:'completed',elapsed_s:65,bands:Array.from({length:12},(_,index)=>({...band,index,seed:'bench:'+index}))};
      const c = document.createElement('canvas'); c.width=720;c.height=960;
      const animate=Weave.createAnimator(c); animate(artwork,65);
      const times=[];
      for(let i=0;i<180;i++){const t=performance.now();animate(artwork,65);times.push(performance.now()-t);}
      const d=document.createElement('canvas');d.width=720;d.height=960;Weave.draw(d.getContext('2d'),artwork,720,960);
      const a=c.getContext('2d').getImageData(0,0,720,960).data,b=d.getContext('2d').getImageData(0,0,720,960).data;
      let error=0;for(let i=0;i<a.length;i++)error+=Math.abs(a[i]-b[i]);
      const full=document.createElement('canvas');full.width=2400;full.height=3200;Weave.draw(full.getContext('2d'),artwork);
      times.sort((a,b)=>a-b);
      return {p95_ms:times[Math.floor(times.length*.95)],mean_pixel_error:error/a.length,export:[full.width,full.height],qr:Array.from(full.getContext('2d').getImageData(2000,2900,1,1).data)};
    });
    assert.deepEqual(result.export,[2400,3200]);
    assert.deepEqual(result.qr,[244,239,229,255]);
    assert.ok(result.mean_pixel_error < 2);
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed:', JSON.stringify(result));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
