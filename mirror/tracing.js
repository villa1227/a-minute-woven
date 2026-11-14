(() => {
  const $=id=>document.getElementById(id),canvas=$('tracingCanvas'),ctx=canvas.getContext('2d');
  let enabled=false,sessionId=null,segments=[],renderer=new BrushRenderer(ctx),referenceHistory=[],configurationHistory=[];
  const input=new PenInput({onEnd:reason=>{renderer.breakPath();if(enabled)segments.push({kind:'break',afterSample:input.samples.length,reason});},onSample:sample=>{
    const brush=window.MirrorSensors?.brush()||{...BioBrush.BASE,color:BioBrush.BASE.color.slice()};
    const metadata=window.MirrorSensors?.metadata();
    // Every reference/config transition used by a mark is preserved, not only final state.
    const ref=JSON.stringify(metadata?.references),config=JSON.stringify(metadata?.configuration);
    if(referenceHistory.at(-1)?.key!==ref)referenceHistory.push({key:ref,atSample:input.samples.length-1,value:metadata?.references});
    if(configurationHistory.at(-1)?.key!==config)configurationHistory.push({key:config,atSample:input.samples.length-1,value:metadata?.configuration});
    segments.push({kind:'sample',sampleIndex:input.samples.length-1,brush});
    renderer.draw(sample,brush);
  }});
  function release(){
    const id=input.active?.id;input.end();
    if(id!==undefined&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
  }
  function clear(){release();ctx.clearRect(0,0,canvas.width,canvas.height);input.reset(enabled?canvas.width:0,enabled?canvas.height:0,sessionId);segments=[];referenceHistory=[];configurationHistory=[];renderer=new BrushRenderer(ctx,sessionId||'mirror');render();}
  function resize(){
    const line=$('lineCanvas'),a=line.getBoundingClientRect(),b=$('drawingSurface').getBoundingClientRect();
    Object.assign(canvas.style,{left:(a.left-b.left)+'px',top:(a.top-b.top)+'px',width:a.width+'px',height:a.height+'px'});
  }
  function enable(width,height,id){
    release();enabled=true;sessionId=id;canvas.width=width;canvas.height=height;canvas.hidden=false;
    input.reset(width,height,id);segments=[];referenceHistory=[];configurationHistory=[];renderer=new BrushRenderer(ctx,id);
    $('lineCanvas').style.opacity='1';$('toggleGuide').textContent='隐藏底稿';resize();render();
  }
  function disable(){release();enabled=false;sessionId=null;input.reset(0,0,null);segments=[];referenceHistory=[];configurationHistory=[];canvas.width=1;canvas.height=1;canvas.hidden=true;$('lineCanvas').style.opacity='1';render();}
  function handle(event){
    if(!enabled)return;
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
    const hide=$('lineCanvas').style.opacity!=='0';$('lineCanvas').style.opacity=hide?'0':'1';$('toggleGuide').textContent=hide?'显示底稿':'隐藏底稿';
  };
  $('mouseFallback').onchange=()=>{release();input.mouseFallback=$('mouseFallback').checked;};
  $('downloadInput').onclick=()=>{
    const data={...input.export(),schemaVersion:2,mapping:window.MirrorSensors?.metadata(),renderSeed:sessionId,
      referenceHistory:referenceHistory.map(({key,...rest})=>rest),configurationHistory:configurationHistory.map(({key,...rest})=>rest),segments};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='mirror-input_'+sessionId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  $('downloadTracing').onclick=()=>{
    const out=document.createElement('canvas');out.width=canvas.width;out.height=canvas.height;
    const context=out.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,out.width,out.height);context.drawImage(canvas,0,0);
    out.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mirror-tracing_'+sessionId+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
  };
  function render(){
    input.mouseFallback=$('mouseFallback').checked;
    const s=input.snapshot(),p=s.latest,pen=p?.pointerType==='pen',fresh=p&&performance.now()-p.receivedTimeMs<1500;
    $('penType').textContent=p?pen?'笔输入':'鼠标回退':'等待输入';
    $('penContact').textContent=s.full?'已达 50,000 点上限，请清除后重试':!enabled?'确认照片并生成线稿后可描摹':!fresh?'等待输入（不代表 USB 断开）':s.contact?'笔尖接触':p.outside?'画布外':'悬停 / 已抬笔';
    $('penPosition').textContent=p?`${p.x.toFixed(1)}, ${p.y.toFixed(1)} px${p.outside?'（越界）':''}`:'—';
    $('penPressure').textContent=pen&&fresh?Number(p.pressure).toFixed(3):p&&!pen?'鼠标压力不作为笔压':'—';
    $('pressureMeter').value=pen&&fresh?p.pressure:0;
    $('penTilt').textContent=pen&&fresh?`${p.tiltX}° / ${p.tiltY}° · 旋转 ${p.twist}°`:'—';
    $('penRate').textContent=s.rate+' 点/秒';$('penCount').textContent=s.count+' 点';
    $('clearTracing').disabled=!enabled;$('toggleGuide').disabled=!enabled;$('downloadInput').disabled=!s.count;$('downloadTracing').disabled=!s.count;
  }
  window.MirrorTracing={enable,disable};setInterval(render,100);render();
})();
