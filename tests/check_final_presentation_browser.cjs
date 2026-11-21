// Set MIRROR_REAL_UPLOAD=1 to upload a synthetic geometry artwork (never a portrait).
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await b.newPage({viewport:{width:1400,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 if(!process.env.MIRROR_REAL_UPLOAD)await p.route('**/api/share/upload',r=>r.fulfill({json:{url:'https://i.imgs.ovh/2026/11/21/synthetic.png',retention:'ImgLoc 默认保存约 1 年'}}));
 await p.goto('http://127.0.0.1:8767/background');
 await p.evaluate(()=>{
   const c=document.getElementById('lineCanvas');c.width=600;c.height=800;c.hidden=false;
   const x=c.getContext('2d');x.strokeStyle='black';x.lineWidth=3;x.strokeRect(90,100,420,540);x.beginPath();x.arc(300,350,100,0,Math.PI*2);x.stroke();
   document.getElementById('linePlaceholder').hidden=true;MirrorTracing.enable(600,800,'synthetic-presentation');
   const paint=document.getElementById('backgroundCanvas'),px=paint.getContext('2d');px.fillStyle='#d7a465';px.fillRect(40,240,520,150);
 });
 const footer=await p.evaluate(()=>{
   const c=MirrorBackgroundComposition.compose(true),x=c.getContext('2d'),data=x.getImageData(0,800,c.width,c.height-800).data;
   let ink=0;for(let i=0;i<data.length;i+=4)if(data[i]<200)ink++;
   const date=ArtworkCaption.timestamp(new Date('2026-11-21T00:30:00Z'));
   return {width:c.width,height:c.height,footerInk:ink,date};
 });assert.equal(footer.height,872);assert.equal(footer.date,'2026-11-21 08:30:00');assert.ok(footer.footerInk>300);
 const shareTop=await p.locator('#artworkShare').evaluate(e=>e.getBoundingClientRect().top+scrollY);
 const devicesTop=await p.locator('#sensorDevices').evaluate(e=>e.getBoundingClientRect().top+scrollY);assert.ok(shareTop<devicesTop);
 assert.equal(await p.locator('#sensorDevices').getAttribute('open'),null);
 await p.check('#shareConsent');await p.click('#shareArtwork');
 await p.waitForFunction(()=>!document.getElementById('shareResult').hidden,{},{timeout:60000});
 const url=await p.locator('#shareLink').getAttribute('href');assert.match(url,/^https:\/\/i\.imgs\.ovh\//);
 assert.equal(await p.locator('#finishedPreview').isVisible(),true);
 const out=path.join(__dirname,'../diagnostics/share');fs.mkdirSync(out,{recursive:true});
 const png=await p.locator('#finishedPreview').evaluate(c=>c.toDataURL().split(',')[1]);fs.writeFileSync(path.join(out,'signed-artwork.png'),Buffer.from(png,'base64'));
 const qr=await p.locator('#shareQr').evaluate(c=>c.toDataURL().split(',')[1]);fs.writeFileSync(path.join(out,'imgloc-qr.png'),Buffer.from(qr,'base64'));
 await p.screenshot({path:path.join(out,'final-desktop.png'),fullPage:true});
 await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.screenshot({path:path.join(out,'final-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({realUpload:!!process.env.MIRROR_REAL_UPLOAD,url,footer,qrAboveDevices:true}));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
