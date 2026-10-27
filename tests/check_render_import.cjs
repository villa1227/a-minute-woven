// Optional offline integration check; requires Playwright and installed Edge.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve(__dirname,'../web/render-artwork.html')).href);
    const artwork = {id:'synthetic-import',renderer:'woven-v1',status:'completed',created_at:'2026-10-27T00:00:00Z',
      bands:Array.from({length:12},(_,index)=>({index,seed:'synthetic:'+index,threads:22,base_threads:22,amplitude:{left:.16,right:.16}}))};
    async function load(data) {
      await page.locator('#file').setInputFiles({name:'artwork.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
    }
    for (const schema_version of [1,2]) {
      await load({...artwork,schema_version});
      await page.waitForFunction(()=>!document.getElementById('download').disabled);
      const pending = page.waitForEvent('download');
      await page.click('#download');
      const download = await pending;
      const stream = await download.createReadStream();
      const chunks=[]; for await (const chunk of stream) chunks.push(chunk);
      const png = Buffer.concat(chunks);
      assert.equal(png.subarray(1,4).toString(),'PNG');
      assert.equal(png.readUInt32BE(16),2400); assert.equal(png.readUInt32BE(20),3200);
    }
    await load({...artwork,schema_version:2,status:'cancelled'});
    await page.waitForFunction(()=>document.getElementById('error').textContent.length>0);
    assert.equal(await page.locator('#download').isDisabled(),true);
    assert.deepEqual(errors,[]);
    console.log('Offline v1/v2 import, PNG dimensions and unfinished-file rejection passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
