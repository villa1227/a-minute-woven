const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));let fail=true,uploads=[];
 await p.route('**/api/sensors*',r=>r.fulfill({json:{connected:true,state:{cameras:[],devices:[],eda_ports:[],eda:{connected:false},expression:{running:false},recording:false},trace:{stream_id:'test',now_s:0,cursor:0,rows:[]}}}));
 await p.route('**/api/share/upload',r=>{uploads.push(r.request().postDataBuffer());return r.fulfill({status:fail?502:200,json:fail?{error:'test offline'}:{url:'https://i.imgs.ovh/2026/11/21/synthetic.png',retention:'默认约 1 年'}});});
 await p.goto('http://127.0.0.1:8767/background');
 await p.evaluate(()=>{const c=document.getElementById('lineCanvas');c.width=400;c.height=500;c.hidden=false;c.getContext('2d').fillRect(40,40,100,100);MirrorTracing.enable(400,500,'share-test');});
 assert.equal(await p.locator('#shareArtwork').isDisabled(),true);
 await p.check('#shareConsent');
 await p.waitForFunction(()=>!document.getElementById('shareArtwork').disabled);
 await p.click('#shareArtwork');await p.waitForFunction(()=>document.getElementById('shareArtwork').textContent.includes('重试'));
 assert.match(await p.locator('#shareStatus').textContent(),/test offline/);assert.ok(await p.evaluate(()=>MirrorShare.frozen));
 assert.equal(await p.locator('#lineWidth').isDisabled(),true);assert.equal(await p.locator('#backgroundOpacity').isDisabled(),true);
 fail=false;await p.click('#shareArtwork');await p.waitForFunction(()=>!document.getElementById('shareResult').hidden);
 assert.equal(await p.locator('#finishedPreview').isVisible(),true);
 assert.equal(await p.locator('#drawingSurface').isVisible(),false);
 assert.equal(uploads.length,2);assert.deepEqual(uploads[0],uploads[1],'retry same frozen image');
 assert.equal(uploads[0].readUInt32BE(16),400);assert.equal(uploads[0].readUInt32BE(20),564);
 assert.equal(await p.locator('#shareLink').getAttribute('href'),'https://i.imgs.ovh/2026/11/21/synthetic.png');
 const qrData=await p.locator('#shareQr').evaluate(c=>c.toDataURL());
 // Decode with OpenCV outside this process in optional diagnostics; matrix below verifies actual URL.
 const valid=await p.evaluate(()=>{const qr=qrcode(0,'M');qr.addData('https://i.imgs.ovh/2026/11/21/synthetic.png');qr.make();const c=document.getElementById('shareQr'),x=c.getContext('2d'),n=qr.getModuleCount(),scale=c.width/(n+8);for(let r=0;r<n;r++)for(let col=0;col<n;col++)if((x.getImageData((col+4)*scale+1,(r+4)*scale+1,1,1).data[0]===0)!==qr.isDark(r,col))return false;return true;});assert.ok(valid);
 assert.equal(await p.locator('#nextParticipant').isDisabled(),false);
 const before=await p.locator('#shareQr').evaluate(c=>c.toDataURL());await p.waitForTimeout(300);assert.equal(before,await p.locator('#shareQr').evaluate(c=>c.toDataURL()));
 await Promise.all([p.waitForEvent('load'),p.click('#nextParticipant')]);assert.equal(await p.locator('#shareResult').isVisible(),false);assert.equal(await p.evaluate(()=>MirrorShare.frozen),false);
 assert.deepEqual(errors,[]);console.log('Sharing failure/retry, frozen PNG, QR contents and next-participant isolation passed.');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
