// Optional integration check. Start the mirror static server on 8767 first.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'diagnostics/mirror');
fs.mkdirSync(out,{recursive:true});

function withOrientation6(jpeg){
  // EXIF TIFF IFD with one Orientation=6 entry (rotate clockwise 90 degrees).
  const payload=Buffer.from([69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
  const marker=Buffer.alloc(4);marker[0]=255;marker[1]=225;marker.writeUInt16BE(payload.length+2,2);
  return Buffer.concat([jpeg.subarray(0,2),marker,payload,jpeg.subarray(2)]);
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1320,height:1200}}),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r));
    await page.addInitScript(()=>{
      window.__cameraStats={opened:0,stopped:0,selected:[]};window.__cameraError=null;
      const original=navigator.mediaDevices;
      Object.defineProperty(navigator,'mediaDevices',{value:{
        enumerateDevices:async()=>[{kind:'videoinput',deviceId:'a',label:'测试镜头 A'},{kind:'videoinput',deviceId:'b',label:'测试镜头 B'}],
        addEventListener:(...args)=>original?.addEventListener(...args),
        getUserMedia:async constraints=>{
          if(window.__cameraError)throw new DOMException('simulated',window.__cameraError);
          const c=document.createElement('canvas');c.width=640;c.height=480;
          const ctx=c.getContext('2d');
          function paint(){ctx.fillStyle='#e03030';ctx.fillRect(0,0,320,480);ctx.fillStyle='#3050d0';ctx.fillRect(320,0,320,480);ctx.strokeStyle='#fff';ctx.lineWidth=5;ctx.strokeRect(160,100,320,280);}
          paint();const stream=c.captureStream(15),track=stream.getVideoTracks()[0],timer=setInterval(paint,66),stop=track.stop.bind(track);
          track.stop=()=>{clearInterval(timer);window.__cameraStats.stopped++;stop();};
          window.__activeTrack=track;window.__cameraStats.opened++;window.__cameraStats.selected.push(constraints.video.deviceId?.exact||'');
          return stream;
        }
      }});
    });
    await page.goto('http://127.0.0.1:8767/');
    await page.waitForFunction(()=>document.getElementById('camera').options.length===3);
    await page.click('#openCamera');await page.waitForFunction(()=>!document.getElementById('capture').disabled);
    await page.click('#capture');
    assert.equal(await page.locator('#confirm').isVisible(),true);
    assert.equal(await page.locator('#lineCanvas').isVisible(),false,'must confirm before rendering');
    let camera=await page.evaluate(()=>window.__cameraStats);assert.equal(camera.opened,camera.stopped,'snapshot releases camera');
    const mirrored=await page.locator('#photoCanvas').evaluate(c=>({w:c.width,h:c.height,left:Array.from(c.getContext('2d').getImageData(10,10,1,1).data)}));
    assert.equal(mirrored.w,640);assert.equal(mirrored.h,480);assert.ok(mirrored.left[2]>mirrored.left[0],'capture mirrors preview');
    await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
    await page.locator('input[value="minimal"]').check();
    await page.waitForFunction(()=>!document.getElementById('download').disabled);
    assert.equal(await page.locator('#sigmaNumber').inputValue(),'2.5');
    await page.locator('#sigmaNumber').fill('3.2');
    await page.waitForFunction(()=>!document.getElementById('download').disabled);
    assert.equal(await page.locator('#sigma').inputValue(),'3.2');
    assert.match(await page.locator('#tuningStatus').textContent(),/自定义/);
    await page.locator('#minHighNumber').fill('512');
    await page.waitForFunction(()=>!document.getElementById('download').disabled);
    const empty=await page.locator('#lineCanvas').evaluate(c=>{
      const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      return data.every(value=>value===255);
    });assert.equal(empty,true,'manual threshold changes the actual extraction');
    await page.click('#resetTuning');await page.waitForFunction(()=>!document.getElementById('download').disabled);
    assert.equal(await page.locator('#sigmaNumber').inputValue(),'2.5');
    assert.equal(await page.locator('#minHighNumber').inputValue(),'35');
    await page.locator('input[value="rich"]').check();
    assert.equal(await page.locator('#sigmaNumber').inputValue(),'1.05');
    await page.locator('#lineWidth').evaluate(e=>{e.value='4';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.getElementById('download').disabled);
    assert.equal(await page.locator('#widthValue').textContent(),'4 px');
    const pending=page.waitForEvent('download');await page.click('#download');
    const download=await pending,stream=await download.createReadStream(),chunks=[];
    for await(const chunk of stream)chunks.push(chunk);
    const png=Buffer.concat(chunks);assert.equal(png.readUInt32BE(16),640);assert.equal(png.readUInt32BE(20),480);
    const white=await page.locator('#lineCanvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,1,1).data));assert.deepEqual(white,[255,255,255,255]);
    await page.screenshot({path:path.join(out,'workflow.png'),fullPage:true});
    await page.click('#retake');await page.waitForFunction(()=>!document.getElementById('capture').disabled);
    assert.equal(await page.locator('#lineCanvas').isVisible(),false);
    await page.selectOption('#camera','b');await page.waitForFunction(()=>window.__cameraStats.opened===3&&!document.getElementById('capture').disabled);
    assert.equal(await page.evaluate(()=>window.__cameraStats.selected.at(-1)),'b');
    await page.evaluate(()=>window.__activeTrack.dispatchEvent(new Event('ended')));
    await page.waitForFunction(()=>!document.getElementById('error').hidden);
    assert.equal(await page.locator('#capture').isVisible(),false);
    camera=await page.evaluate(()=>window.__cameraStats);assert.equal(camera.opened,camera.stopped);
    for(const name of ['NotAllowedError','NotReadableError','NotFoundError']){
      await page.evaluate(name=>window.__cameraError=name,name);await page.click('#openCamera');
      await page.waitForFunction(()=>!document.getElementById('openCamera').disabled);
      assert.equal(await page.locator('#error').isVisible(),true);assert.equal(await page.locator('.file-button').isVisible(),true);
    }
    await page.evaluate(()=>window.__cameraError=null);
    const jpeg=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=120;c.height=80;
      const ctx=c.getContext('2d');ctx.fillStyle='#f02020';ctx.fillRect(0,0,60,80);ctx.fillStyle='#2040f0';ctx.fillRect(60,0,60,80);
      return c.toDataURL('image/jpeg',1).split(',')[1];
    });
    await page.locator('#photoFile').setInputFiles({name:'phone.jpg',mimeType:'image/jpeg',buffer:withOrientation6(Buffer.from(jpeg,'base64'))});
    await page.waitForFunction(()=>!document.getElementById('confirm').hidden);
    const oriented=await page.locator('#photoCanvas').evaluate(c=>({w:c.width,h:c.height,top:Array.from(c.getContext('2d').getImageData(10,10,1,1).data),bottom:Array.from(c.getContext('2d').getImageData(10,c.height-10,1,1).data)}));
    assert.equal(oriented.w,80);assert.equal(oriented.h,120);assert.ok(oriented.top[0]>oriented.top[2]);assert.ok(oriented.bottom[2]>oriented.bottom[0]);
    await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
    const cancellation=await page.evaluate(async()=>{
      const p=new LineArtProcessor(),data=new ImageData(1600,1600);data.data.fill(255);
      const first=p.generate(data,{detail:'rich'}).then(()=>false,e=>e.name==='AbortError');
      const second=p.generate(new ImageData(2,2),{detail:'standard'});
      const cancelled=await first,done=await second;p.dispose();return {cancelled,width:done.width};
    });
    assert.deepEqual(cancellation,{cancelled:true,width:2});
    // Large generated photo: preserve ratio, cap size, keep UI animation alive.
    const large=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=2400;c.height=1800;
      const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
      for(let i=0;i<100;i++){ctx.strokeStyle=`rgb(${i},${i},${i})`;ctx.beginPath();ctx.ellipse(1200,850,100+i*6,120+i*7,0,0,Math.PI*2);ctx.stroke();}
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#photoFile').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.from(large,'base64')});
    await page.waitForFunction(()=>!document.getElementById('confirm').hidden);
    assert.deepEqual(await page.locator('#photoCanvas').evaluate(c=>[c.width,c.height]),[1600,1200]);
    await page.click('#confirm');
    const responsive=await page.evaluate(async()=>{
      let frames=0;
      while(document.getElementById('download').disabled){await new Promise(requestAnimationFrame);frames++;if(frames>1200)throw Error('render timeout');}
      return frames;
    });
    assert.ok(responsive>1,'worker must leave main thread responsive');
    await page.evaluate(()=>{document.querySelector('input[value="simple"]').click();document.querySelector('input[value="rich"]').click();document.querySelector('input[value="standard"]').click();});
    await page.waitForFunction(()=>!document.getElementById('download').disabled);
    const matches=await page.evaluate(async()=>{
      const photo=document.getElementById('photoCanvas'),source=photo.getContext('2d').getImageData(0,0,photo.width,photo.height);
      const p=new LineArtProcessor(),r=await p.generate(source,{detail:'standard',lineWidth:4});p.dispose();
      const actual=document.getElementById('lineCanvas').getContext('2d').getImageData(0,0,r.width,r.height).data;
      for(let i=0;i<actual.length;i+=4)if(actual[i]!==255-r.layer.data[i+3]||actual[i+3]!==255)return false;
      return true;
    });assert.equal(matches,true,'latest settings equal direct render from original photo');
    const portrait=path.join(out,'grace_hopper.jpg');
    const portraitStats=[];
    if(fs.existsSync(portrait)){
      await page.locator('#photoFile').setInputFiles(portrait);await page.waitForFunction(()=>!document.getElementById('confirm').hidden);
      await page.click('#confirm');await page.waitForFunction(()=>!document.getElementById('download').disabled);
      await page.locator('#lineWidth').evaluate(e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});
      for(const detail of ['minimal','simple','standard','rich']){
        await page.locator(`input[value="${detail}"]`).check();await page.waitForFunction(()=>!document.getElementById('download').disabled);
        const data=await page.locator('#lineCanvas').evaluate(c=>c.toDataURL().split(',')[1]);
        fs.writeFileSync(path.join(out,`portrait-${detail}.png`),Buffer.from(data,'base64'));
        portraitStats.push(await page.evaluate(detail=>{
          const c=document.getElementById('lineCanvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let black=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<128)black++;
          return {detail,blackPixels:black,processing:document.getElementById('resultMeta').textContent};
        },detail));
      }
      assert.ok(portraitStats.every((stat,i)=>i===0||stat.blackPixels>portraitStats[i-1].blackPixels));
      await page.locator('input[value="standard"]').check();await page.waitForFunction(()=>!document.getElementById('download').disabled);
      await page.screenshot({path:path.join(out,'portrait-page.png'),fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
    await page.locator('#photoFile').setInputFiles({name:'bad.png',mimeType:'image/png',buffer:Buffer.from('invalid image')});
    await page.waitForFunction(()=>!document.getElementById('error').hidden);
    assert.equal(await page.locator('#download').isDisabled(),true);
    await page.click('#openCamera');await page.waitForFunction(()=>!document.getElementById('capture').disabled);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    camera=await page.evaluate(()=>window.__cameraStats);assert.equal(camera.opened,camera.stopped);
    assert.equal(await page.locator('#photoCanvas').evaluate(c=>c.width),1);
    assert.equal(requests.some(r=>new URL(r.url()).origin!=='http://127.0.0.1:8767'),false,'no external requests');
    assert.equal(requests.some(r=>r.method()!=='GET'),false,'no uploads');assert.deepEqual(errors,[]);
    console.log('Mirror browser checks passed:',JSON.stringify({mirrored,oriented,mainThreadFrames:responsive,portraitChecked:fs.existsSync(portrait),portraitStats}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
