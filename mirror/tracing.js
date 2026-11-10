(() => {
  const $=id=>document.getElementById(id),canvas=$('tracingCanvas'),ctx=canvas.getContext('2d');
  let previous=null,enabled=false,sessionId=null;
  const input=new PenInput({onEnd:()=>{previous=null;},onSample:sample=>{
    if(!sample.contact||sample.outside){previous=null;return;}
    ctx.strokeStyle='#000';ctx.fillStyle='#000';ctx.lineWidth=2;ctx.lineCap='round';ctx.lineJoin='round';
    if(previous){ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(sample.x,sample.y);ctx.stroke();}
    else {ctx.beginPath();ctx.arc(sample.x,sample.y,1,0,Math.PI*2);ctx.fill();}
    previous=sample;
  }});
  function release(){
    const id=input.active?.id;input.end();
    if(id!==undefined&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
  }
  function clear(){release();ctx.clearRect(0,0,canvas.width,canvas.height);input.reset(enabled?canvas.width:0,enabled?canvas.height:0,sessionId);render();}
  function resize(){
    const line=$('lineCanvas'),a=line.getBoundingClientRect(),b=$('drawingSurface').getBoundingClientRect();
    Object.assign(canvas.style,{left:(a.left-b.left)+'px',top:(a.top-b.top)+'px',width:a.width+'px',height:a.height+'px'});
  }
  function enable(width,height,id){
    release();enabled=true;sessionId=id;canvas.width=width;canvas.height=height;canvas.hidden=false;
    input.reset(width,height,id);$('lineCanvas').style.opacity='1';$('toggleGuide').textContent='隐藏底稿';resize();render();
  }
  function disable(){release();enabled=false;sessionId=null;input.reset(0,0,null);canvas.width=1;canvas.height=1;canvas.hidden=true;$('lineCanvas').style.opacity='1';render();}
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
  canvas.addEventListener('pointerleave',()=>{previous=null;if(!input.active&&input.latest)input.latest={...input.latest,outside:true};});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  window.addEventListener('blur',release);window.addEventListener('pagehide',disable);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
  new ResizeObserver(()=>{previous=null;resize();}).observe($('drawingSurface'));
  $('clearTracing').onclick=clear;
  $('toggleGuide').onclick=()=>{
    const hide=$('lineCanvas').style.opacity!=='0';$('lineCanvas').style.opacity=hide?'0':'1';$('toggleGuide').textContent=hide?'显示底稿':'隐藏底稿';
  };
  $('mouseFallback').onchange=()=>{release();input.mouseFallback=$('mouseFallback').checked;};
  $('downloadInput').onclick=()=>{
    const blob=new Blob([JSON.stringify(input.export(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='mirror-input_'+sessionId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
    $('clearTracing').disabled=!enabled;$('toggleGuide').disabled=!enabled;$('downloadInput').disabled=!s.count;
  }
  window.MirrorTracing={enable,disable};setInterval(render,100);render();
})();
