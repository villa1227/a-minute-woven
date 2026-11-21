(() => {
  const $=id=>document.getElementById(id),canvas=$('tracingCanvas'),paint=$('backgroundCanvas'),ctx=paint.getContext('2d');
  let enabled=false,sessionId=null,createdAt=null,segments=[],renderer=new BackgroundBrush.BackgroundBrushRenderer(ctx),referenceHistory=[],configurationHistory=[];
  const input=new PenInput({onEnd:reason=>{renderer.breakPath();if(enabled)segments.push({kind:'break',afterSample:input.samples.length,reason});},onSample:sample=>{
    const brush=window.MirrorBackground.adapt(window.MirrorSensors?.brush()||{...BioBrush.BASE,color:BioBrush.BASE.color.slice()});
    const metadata=window.MirrorSensors?.metadata();
    // Every reference/config transition used by a mark is preserved, not only final state.
    const ref=JSON.stringify(metadata?.references),config=JSON.stringify({...metadata?.configuration,diameterPercent:Number($('backgroundDiameter').value)});
    if(referenceHistory.at(-1)?.key!==ref)referenceHistory.push({key:ref,atSample:input.samples.length-1,value:metadata?.references});
    if(configurationHistory.at(-1)?.key!==config)configurationHistory.push({key:config,atSample:input.samples.length-1,value:{...metadata?.configuration,diameterPercent:Number($('backgroundDiameter').value)}});
    segments.push({kind:'sample',sampleIndex:input.samples.length-1,brush});
    renderer.draw(sample,brush);
  }});
  function release(){
    const id=input.active?.id;input.end();
    if(id!==undefined&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
  }
  function clear(){release();ctx.clearRect(0,0,canvas.width,canvas.height);input.reset(enabled?canvas.width:0,enabled?canvas.height:0,sessionId);segments=[];referenceHistory=[];configurationHistory=[];renderer=new BackgroundBrush.BackgroundBrushRenderer(ctx,sessionId||'mirror');render();}
  function resize(){
    const line=$('lineCanvas'),a=line.getBoundingClientRect(),b=$('drawingSurface').getBoundingClientRect();
    for(const layer of [canvas,paint,$('wovenCanvas')])Object.assign(layer.style,{left:(a.left-b.left)+'px',top:(a.top-b.top)+'px',width:a.width+'px',height:a.height+'px'});
  }
  function enable(width,height,id){
    createdAt=new Date().toISOString();
    if($('artworkCaptionTime'))$('artworkCaptionTime').textContent=ArtworkCaption.timestamp(new Date(createdAt))+' · UTC+08:00';
    release();enabled=true;sessionId=id;canvas.width=paint.width=width;canvas.height=paint.height=height;canvas.hidden=paint.hidden=false;
    input.reset(width,height,id);segments=[];referenceHistory=[];configurationHistory=[];renderer=new BackgroundBrush.BackgroundBrushRenderer(ctx,id);
    window.MirrorWoven?.setup(width,height,id);
    $('lineCanvas').style.opacity='1';$('toggleGuide').textContent='隐藏线稿';resize();render();
  }
  function disable(){release();enabled=false;sessionId=null;input.reset(0,0,null);segments=[];referenceHistory=[];configurationHistory=[];window.MirrorWoven?.clear();canvas.width=paint.width=1;canvas.height=paint.height=1;canvas.hidden=paint.hidden=true;$('lineCanvas').style.opacity='1';render();}
  function handle(event){
    if(!enabled||document.body.dataset.artworkFinished==='true')return;
    if(event.type==='pointerdown'&&event.pointerType!=='touch')event.preventDefault();
    input.process(event,canvas.getBoundingClientRect());
    if(input.active&&!canvas.hasPointerCapture(event.pointerId)){
      try{canvas.setPointerCapture(event.pointerId);}catch(_){}
    }
    if(!input.active&&canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
  }
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])canvas.addEventListener(type,handle);
  canvas.addEventListener('lostpointercapture',()=>input.end('capture_lost'));
  canvas.addEventListener('pointerleave',()=>{if(enabled&&renderer.previous)segments.push({kind:'break',afterSample:input.samples.length,reason:'leave'});renderer.breakPath();if(!input.active&&input.latest)input.latest={...input.latest,outside:true};});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  window.addEventListener('blur',release);window.addEventListener('pagehide',disable);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
  new ResizeObserver(()=>{if(enabled&&renderer.previous)segments.push({kind:'break',afterSample:input.samples.length,reason:'resize'});renderer.breakPath();resize();}).observe($('drawingSurface'));
  $('clearTracing').onclick=clear;
  $('toggleGuide').onclick=()=>{
    const hide=$('lineCanvas').style.opacity!=='0';$('lineCanvas').style.opacity=hide?'0':'1';$('toggleGuide').textContent=hide?'显示线稿':'隐藏线稿';
  };
  $('mouseFallback').onchange=()=>{release();input.mouseFallback=$('mouseFallback').checked;};
  $('downloadInput').onclick=()=>{
    const data={...input.export(),schemaVersion:2,mapping:window.MirrorSensors?.metadata(),renderSeed:sessionId,frontendVersion:'background-v1',renderer:BackgroundBrush.VERSION,
      createdAt,caption:'Cyber Mirror',backgroundOpacity:window.MirrorBackground.opacity(),woven:window.MirrorWoven?.export(),layerOrder:['white-paper','woven','background-paint','transparent-line-art','input-surface'],baseDiameter:Math.max(canvas.width,canvas.height)*Number($('backgroundDiameter').value)/100,diameterPercent:Number($('backgroundDiameter').value),
      referenceHistory:referenceHistory.map(({key,...rest})=>rest),configurationHistory:configurationHistory.map(({key,...rest})=>rest),segments};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='mirror-background-input_'+sessionId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  function compose(includeLines){
    const out=document.createElement('canvas');out.width=paint.width;out.height=paint.height+(includeLines?ArtworkCaption.height(paint.width):0);
    const context=out.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,out.width,out.height);
    window.MirrorWoven?.compose(context);
    context.save();context.globalAlpha=window.MirrorBackground.opacity();context.drawImage(paint,0,0);context.restore();
    // Complete artwork always includes the lines, even if hidden for preview.
    if(includeLines){context.drawImage($('lineCanvas'),0,0);ArtworkCaption.draw(context,out.width,paint.height,createdAt||new Date().toISOString());}
    return out;
  }
  async function download(includeLines){
    if(!enabled)return;
    const out=compose(includeLines),id=sessionId;
    const blob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));out.width=1;
    if(!blob)return;
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;
    a.download=(includeLines?'mirror-artwork_':'mirror-background_')+id+'.png';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('downloadTracing').onclick=()=>download(false);
  $('downloadArtwork').onclick=()=>download(true);
  function render(){
    input.mouseFallback=$('mouseFallback').checked;
    const s=input.snapshot(),p=s.latest,pen=p?.pointerType==='pen',fresh=p&&performance.now()-p.receivedTimeMs<1500;
    $('penType').textContent=p?pen?'笔输入':'鼠标回退':'等待输入';
    $('penContact').textContent=s.full?'已达 50,000 点上限，请清除后重试':!enabled?'确认照片并生成线稿后可涂绘背景':!fresh?'等待输入（不代表 USB 断开）':s.contact?'笔尖接触':p.outside?'画布外':'悬停 / 已抬笔';
    $('penPosition').textContent=p?`${p.x.toFixed(1)}, ${p.y.toFixed(1)} px${p.outside?'（越界）':''}`:'—';
    $('penPressure').textContent=pen&&fresh?Number(p.pressure).toFixed(3):p&&!pen?'鼠标压力不作为笔压':'—';
    $('pressureMeter').value=pen&&fresh?p.pressure:0;
    $('penTilt').textContent=pen&&fresh?`${p.tiltX}° / ${p.tiltY}° · 旋转 ${p.twist}°`:'—';
    $('penRate').textContent=s.rate+' 点/秒';$('penCount').textContent=s.count+' 点';
    $('clearTracing').disabled=!enabled;$('toggleGuide').disabled=!enabled;$('downloadInput').disabled=!s.count;$('downloadTracing').disabled=!s.count;$('downloadArtwork').disabled=!enabled;
    if(document.body.dataset.artworkFinished==='true'){$('clearTracing').disabled=true;$('toggleGuide').disabled=true;}
    window.MirrorShare?.ready(enabled);
  }
  window.MirrorTracing={enable,disable};window.MirrorBackgroundComposition={compose};setInterval(render,100);render();
})();
