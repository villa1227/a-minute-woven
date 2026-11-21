(() => {
  const $=id=>document.getElementById(id),mapping=new BioBrush.BrushMapping();
  let cursor=null,streamId=null,busy=false,message='正在连接原采集服务…',received=null;
  const token=document.querySelector('meta[name="mirror-token"]').content;
  async function poll(){
    if(busy)return;busy=true;
    try{
      const query=cursor===null?'':`?after=${cursor}&stream_id=${encodeURIComponent(streamId)}`;
      const response=await fetch('/api/sensors'+query,{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(7000)});
      if(!response.ok)throw Error(response.status===403?'镜子服务已重启，请刷新页面。':'请使用 python mirror/serve.py 启动镜子数据服务。');
      const packet=await response.json();mapping.ingest(packet);window.MirrorDevices?.receive(packet);received=performance.now();
      window.MirrorWoven?.ingest(packet);
      if(packet.connected){cursor=packet.trace.cursor;streamId=packet.trace.stream_id;message=packet.mode==='integrated'?'采集与绘画已整合 · 在本页管理设备':'已复用原采集服务 · 在本页管理设备';}
      else {cursor=null;streamId=null;message=packet.error||'采集服务暂不可用，继续使用基础画笔。';}
    }catch(error){mapping.disconnect();window.MirrorDevices?.receive({connected:false});cursor=null;streamId=null;message=error.message||'数据连接中断';}
    finally{busy=false;setTimeout(poll,200);}
  }
  $('mappingEnabled').onchange=()=>{mapping.enabled=$('mappingEnabled').checked;};
  $('reverseEda').onchange=()=>{mapping.reverseEda=$('reverseEda').checked;};
  $('feedbackStrength').oninput=()=>{mapping.intensity=Number($('feedbackStrength').value);$('feedbackStrengthValue').textContent=mapping.intensity+' · '+(mapping.intensity<2?'温和':mapping.intensity<4?'明显':'强烈');};
  $('setBrushReference').onclick=()=>{mapping.setReference();$('referenceNotice').textContent='已更新有足够有效样本的通道；其余通道参考未就绪。';};
  function newPhoto(){mapping.reset();$('referenceNotice').textContent='新照片：请采集约 5 秒后设置个人参考。';}
  const preview=$('brushPreview'),ctx=preview.getContext('2d');
  function render(){
    if(received!==null&&performance.now()-received>1500)mapping.disconnect();
    const brush=window.MirrorBackground.adapt(mapping.brush()),diag=mapping.diagnostics();
    window.MirrorBackground.readout(brush);
    $('sensorConnection').textContent=message+(busy?'':'');
    for(const [key,name] of [['left','左眼'],['right','右眼'],['heart','心率'],['eda','皮电 ADC']]){
      const d=diag[key];$('channel'+key).textContent=`${name}：${d.value===null?'无有效数据':d.value.toFixed(1)} · ${d.reference===null?'参考未就绪':'参考 '+d.reference.toFixed(1)}`;
    }
    const e=mapping.expression,ef=mapping.connected&&e&&mapping.now()-e.t<1;
    $('channelExpression').textContent='表情：'+(ef?'七类分数有效':'无有效数据');
    $('brushParameters').textContent=`强度 ${mapping.intensity} · ${brush.width.toFixed(2)} px · 透明度 ${brush.opacity.toFixed(2)} · 柔边 ${brush.softness.toFixed(2)} · 摆动 ${brush.wobble.toFixed(2)} px · ${brush.family}`;
    ctx.clearRect(0,0,preview.width,preview.height);
    const renderer=new BackgroundBrush.BackgroundBrushRenderer(ctx,'preview');
    for(let x=8;x<preview.width-8;x+=2)renderer.draw({contact:true,outside:false,x,y:preview.height/2,strokeId:1,eventTimeMs:x*10},{...brush,width:Math.min(brush.width,30),softness:Math.min(brush.softness,4)});
  }
  window.MirrorSensors={mapping,newPhoto,brush:()=>mapping.brush(),metadata:()=>({version:BioBrush.VERSION,references:mapping.references(),
    configuration:{enabled:mapping.enabled,reverseEda:mapping.reverseEda,intensity:mapping.intensity},palette:BioBrush.PALETTE})};
  poll();setInterval(render,100);render();
})();
