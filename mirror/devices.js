/* Unified device controls. Reuses the collector's command and error semantics. */
(() => {
  const $=id=>document.getElementById(id),token=document.querySelector('meta[name="mirror-token"]').content;
  let state=null,connected=false,busy=false,photoActive=false,frameURL=null,faceURL=null,drag=null,frameBusy=false;
  function options(id,items,key,label){
    const select=$(id),signature=JSON.stringify(items.map(item=>[item[key],label(item)]));
    if(select.dataset.signature===signature)return;
    const selected=select.value;select.dataset.signature=signature;
    select.replaceChildren(...items.map(item=>new Option(label(item),item[key])));
    if(items.some(item=>String(item[key])===selected))select.value=selected;
    if(!items.length)select.append(new Option('暂无可用设备',''));
  }
  async function command(name,data={},quiet=false){
    if(!quiet)$('deviceError').textContent='';
    const response=await fetch('/api/device/'+name,{method:'POST',headers:{'Content-Type':'application/json','X-Mirror-Token':token},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'设备操作失败');
    return result;
  }
  async function act(name,data={}){
    if(busy)return;busy=true;render();
    try{await command(name,data);}
    catch(error){$('deviceError').textContent=error.message||'设备连接失败';}
    finally{busy=false;render();}
  }
  function render(){
    const s=state||{},lock=busy||!connected,recording=s.recording||s.artwork_running;
    options('sensorCamera',s.cameras||[],'index',c=>c.index+' · '+c.name);
    const faceSelect=$('sensorFaceCamera');
    if(faceSelect){
      options('sensorFaceCamera',[{index:'',name:'共用双眼摄像头'},...(s.cameras||[])],'index',c=>c.index===''?c.name:c.index+' · '+c.name);
      faceSelect.disabled=lock||s.expression?.running||s.face_camera_alive||recording||photoActive;
    }
    options('sensorHeart',s.devices||[],'address',d=>(d.name||'BLE')+' · '+d.address);
    options('sensorEda',s.eda_ports||[],'port',p=>p.port+' · '+p.description);
    $('sensorCameraStart').disabled=lock||s.camera_alive||recording||photoActive||!s.cameras?.length;
    $('sensorCameraStop').disabled=lock||!s.camera_alive;
    $('sensorCamera').disabled=lock||s.camera_alive||recording||photoActive;
    $('sensorEyeRate').disabled=$('sensorCamera').disabled;
    $('sensorExpressionStart').disabled=lock||(!s.camera_alive&&!faceSelect?.value)||s.expression?.running||recording||photoActive;
    $('sensorExpressionStop').disabled=lock||(!s.expression?.running&&!s.face_camera_alive);
    $('sensorHeartScan').disabled=lock||s.scanning||s.heart_alive;
    $('sensorHeartConnect').disabled=lock||s.heart_alive||!s.devices?.length;
    $('sensorHeartStop').disabled=lock||!s.heart_alive;
    $('sensorEdaScan').disabled=lock;
    $('sensorEdaConnect').disabled=lock||s.eda?.connected||recording||!s.eda_ports?.length;
    $('sensorEdaStop').disabled=lock||!s.eda?.connected;
    $('sensorRecord').disabled=lock||s.artwork_running;
    $('sensorRecord').textContent=s.recording?'停止并保存记录':'开始原始记录';
    $('sensorMarkerButton').disabled=lock||!s.recording;
    $('sensorAutoRoi').disabled=lock||!s.camera_alive||s.artwork_running;
    $('deviceSummary').textContent=!connected?'采集服务未连接':photoActive?'正在浏览器拍照 · 采集摄像头已暂停':
      `摄像头 ${s.camera_alive?'开启':'关闭'} · 表情 ${s.expression?.running?'开启':'关闭'} · 心率 ${s.heart_alive?'连接中/已连接':'未连接'} · 皮电 ${s.eda?.connected?'已连接':'未连接'}`;
    $('deviceCameraStatus').textContent=s.messages?.camera||'等待摄像头';
    $('deviceExpressionStatus').textContent=s.expression?.error||
      (s.messages?.face_camera?.includes('错误')?s.messages.face_camera:
      s.expression?.running?(s.face_camera_alive?'独立全脸摄像头 · 表情识别中':'共用摄像头 · 表情识别中'):'表情未开启');
    $('deviceHeartStatus').textContent=s.scanning?'蓝牙扫描中，约 8 秒…':s.messages?.heart||'心率未连接';
    $('deviceEdaStatus').textContent=s.eda_ports_error||s.eda?.status||'皮电未连接';
    const eyes=s.camera_sample?.eyes||{};
    $('deviceEyeStatus').textContent=['image_left','image_right'].map((side,i)=>`${i?'右':'左'}眼：${eyes[side]?.candidate_diameter_px?.toFixed(1)??'—'} px · ${eyes[side]?.quality??'等待候选'}`).join(' / ');
    $('deviceRecordStatus').textContent=s.recording?`记录中 ${(s.elapsed_s||0).toFixed(1)} s · ${Object.entries(s.counts||{}).map(([k,v])=>k+': '+v).join(' / ')}`:s.note||'记录保存至本机 recordings/';
    if(document.body.dataset.artworkFinished==='true')for(const e of document.querySelectorAll('#sensorDevices button,#sensorDevices input,#sensorDevices select'))e.disabled=true;
  }
  async function beforePhoto(){
    // Called by an explicit photo action only. Never stop someone else's active recording.
    if(!connected){photoActive=true;render();return;}
    const read=await fetch('/api/sensors',{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(7000)});
    if(!read.ok)throw Error('无法确认摄像头状态，请刷新后重试。');
    const packet=await read.json();
    if(packet.connected)state=packet.state;
    if(state?.recording||state?.artwork_running)throw Error('请先在本页停止记录或结束原作品，再拍照；不会中断正在保存的记录。');
    photoActive=true;render();
    if(state?.face_camera_alive||state?.expression?.running){
      try{await command('expression_stop');}catch(error){photoActive=false;render();throw error;}
    }
    if(state?.camera_alive||state?.face_camera_alive){
      try{
        await command('camera_stop');
        const deadline=performance.now()+7000;
        while(performance.now()<deadline){
          const response=await fetch('/api/sensors',{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(7000)});
          const result=await response.json();
          if(result.connected&&!result.state.camera_alive&&!result.state.face_camera_alive){state=result.state;render();return;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw Error('采集摄像头尚未释放，请稍后重试。');
      }catch(error){photoActive=false;render();throw error;}
    }
  }
  function photoEnded(){photoActive=false;render();}
  $('sensorCameraStart').onclick=()=>act('camera_start',{index:Number($('sensorCamera').value),rate:Number($('sensorEyeRate').value),save_frames:false});
  $('sensorCameraStop').onclick=()=>act('camera_stop');
  $('sensorExpressionStart').onclick=()=>{const index=$('sensorFaceCamera')?.value;act('expression_start',{rate:5,...(index!==''&&index!=null?{camera_index:Number(index)}:{})});};$('sensorExpressionStop').onclick=()=>act('expression_stop');
  $('sensorHeartScan').onclick=()=>act('scan');$('sensorHeartConnect').onclick=()=>act('heart_connect',{address:$('sensorHeart').value});$('sensorHeartStop').onclick=()=>act('heart_stop');
  $('sensorEdaScan').onclick=()=>act('eda_scan');$('sensorEdaConnect').onclick=()=>act('eda_connect',{port:$('sensorEda').value});$('sensorEdaStop').onclick=()=>act('eda_stop');
  $('sensorRecord').onclick=()=>act(state?.recording?'record_stop':'record_start');
  $('sensorMarkerButton').onclick=()=>act('marker',{label:$('sensorMarker').value});
  $('sensorAutoRoi').onclick=()=>act('roi',{side:'both',roi:null});
  const image=$('sensorFrame'),selection=$('sensorSelection');
  function point(e){const r=image.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
  image.onpointerdown=e=>{
    if(!state?.camera_fresh||state.artwork_running||busy||image.hidden)return;
    const sample=state.camera_sample;if(!sample?.frame_width)return;
    e.preventDefault();drag={...point(e),width:sample.frame_width,height:sample.frame_height,side:$('sensorRoiSide').value};
    image.setPointerCapture(e.pointerId);selection.hidden=false;
  };
  image.onpointermove=e=>{if(!drag)return;const p=point(e),r=image.getBoundingClientRect(),b=$('sensorFrameBox').getBoundingClientRect();
    Object.assign(selection.style,{left:r.left-b.left+Math.min(p.x,drag.x)*r.width+'px',top:r.top-b.top+Math.min(p.y,drag.y)*r.height+'px',width:Math.abs(p.x-drag.x)*r.width+'px',height:Math.abs(p.y-drag.y)*r.height+'px'});
  };
  image.onpointerup=e=>{if(!drag)return;const d=drag,p=point(e);drag=null;selection.hidden=true;
    act('roi',{side:d.side,roi:[Math.min(p.x,d.x)*d.width,Math.min(p.y,d.y)*d.height,Math.abs(p.x-d.x)*d.width,Math.abs(p.y-d.y)*d.height].map(Math.round)});
  };
  image.onpointercancel=()=>{drag=null;selection.hidden=true;};
  image.onlostpointercapture=()=>{drag=null;selection.hidden=true;};
  window.addEventListener('blur',()=>{drag=null;selection.hidden=true;});
  async function preview(){
    const faceImage=$('sensorFaceFrame');
    if(faceImage&&!document.hidden&&$('sensorDevices').open&&state?.face_camera_alive&&!photoActive){
      try{const r=await fetch('/api/device-frame?source=face',{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(3000)});
        if(r.status===200){const next=URL.createObjectURL(await r.blob()),old=faceURL;faceURL=next;faceImage.src=next;faceImage.hidden=false;if(old)URL.revokeObjectURL(old);}
        else faceImage.hidden=true;
      }catch(_){faceImage.hidden=true;}
    }else if(faceImage){faceImage.hidden=true;if(faceURL){URL.revokeObjectURL(faceURL);faceURL=null;}}
    if(!frameBusy&&!document.hidden&&$('sensorDevices').open&&state?.camera_alive&&!photoActive&&!drag){
      frameBusy=true;
      try{
        const response=await fetch('/api/device-frame',{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(4000)});
        if(response.status===200){const next=URL.createObjectURL(await response.blob());
          const old=frameURL;frameURL=next;image.src=next;image.hidden=false;if(old)URL.revokeObjectURL(old);
        }else image.hidden=true;
      }catch(_){image.hidden=true;}finally{frameBusy=false;}
    }else if(!state?.camera_alive||photoActive){image.hidden=true;if(frameURL){URL.revokeObjectURL(frameURL);frameURL=null;}}
    setTimeout(preview,100);
  }
  window.addEventListener('pagehide',()=>{if(frameURL)URL.revokeObjectURL(frameURL);if(faceURL)URL.revokeObjectURL(faceURL);});
  window.MirrorDevices={receive(packet){connected=!!packet.connected;if(connected)state=packet.state;render();},beforePhoto,photoEnded};
  render();preview();
})();
