(() => {
  'use strict';
  const $=id=>document.getElementById(id),processor=new LineArtProcessor();
  const photo=$('photoCanvas'),line=$('lineCanvas'),video=$('video');
  let stream=null,source=null,result=null,phase='empty',sourceKind=null;
  let operation=0,renderRevision=0,debounce=null,opening=false,exporting=false;
  const downloadableURLs=new Set();
  const tuningSpecs=[
    {key:'sigma',label:'平滑强度',step:.05,hint:'越大越能抑制皮肤、头发的细碎纹理，也可能删去五官细节。'},
    {key:'percentile',label:'边缘筛选分位',step:.01,hint:'越大越偏向强边缘，通常线条更少；与平滑共同影响结果。'},
    {key:'minHigh',label:'最低边缘阈值',step:1,hint:'越大越忽略浅淡轮廓。它是自动阈值的下限，较小时可能看不出变化。'},
    {key:'minComponent',label:'碎线过滤长度',step:1,hint:'越大越能删除短小孤立线。以最长边 1000 px 为参考，实际随尺寸缩放、最少保留 4 点。'},
    {key:'lowRatio',label:'弱边缘连接比例',step:.01,hint:'调小更容易连接弱线，调大更严格、可能断线。'}
  ];
  const presetNames={minimal:'极简',simple:'简洁',standard:'标准',rich:'丰富'};
  let customTuning=false;
  for(const spec of tuningSpecs){
    const [min,max]=LineArtEngine.RANGES[spec.key],row=document.createElement('div');row.className='tuning-control';
    const label=document.createElement('label');label.htmlFor=spec.key;label.textContent=spec.label;
    const number=document.createElement('input');number.type='number';number.id=spec.key+'Number';number.setAttribute('aria-label',spec.label+'数值');
    const range=document.createElement('input');range.type='range';range.id=spec.key;range.setAttribute('aria-label',spec.label);
    for(const input of [number,range]){input.min=min;input.max=max;input.step=spec.step;}
    const hint=document.createElement('small');hint.textContent=spec.hint;
    const changed=input=>{
      if(!input.validity.valid||input.value==='')return;
      const value=Number(input.value);range.value=value;number.value=value;
      customTuning=true;updateTuningStatus();scheduleRender();
    };
    range.oninput=()=>changed(range);number.oninput=()=>changed(number);
    number.onchange=()=>{if(!number.validity.valid||number.value==='')number.value=range.value;};
    row.append(label,number,range,hint);$('tuningInputs').append(row);
  }
  function updateTuningStatus(){
    const detail=document.querySelector('input[name="detail"]:checked').value;
    $('tuningStatus').textContent=customTuning?'自定义 · 基于'+presetNames[detail]:presetNames[detail]+'预设';
  }
  function applyPreset(){
    const values=LineArtEngine.PRESETS[document.querySelector('input[name="detail"]:checked').value];
    for(const {key} of tuningSpecs){$(key).value=values[key];$(key+'Number').value=values[key];}
    customTuning=false;updateTuningStatus();
  }
  applyPreset();
  const savedPreset=window.MirrorLinePreset?.load();
  if(savedPreset){
    const selected=document.querySelector('input[name="detail"][value="'+savedPreset.detail+'"]');
    if(selected)selected.checked=true;
    const values=LineArtEngine.resolveParameters(savedPreset);
    for(const {key} of tuningSpecs){$(key).value=values[key];$(key+'Number').value=values[key];}
    $('lineWidth').value=values.lineWidth;$('widthValue').textContent=values.lineWidth+' px';
    customTuning=true;updateTuningStatus();$('savedPresetStatus').textContent='已载入本机保存的预设';
  }
  $('saveLinePreset').onclick=()=>{
    const options={detail:document.querySelector('input[name="detail"]:checked').value,lineWidth:Number($('lineWidth').value),
      tuning:Object.fromEntries(tuningSpecs.map(({key})=>[key,Number($(key).value)]))};
    try{MirrorLinePreset.save(options);$('savedPresetStatus').textContent='已保存为本机预设，下次打开自动使用';}
    catch(_){$('savedPresetStatus').textContent='保存失败，请检查数值范围及浏览器存储权限';}
  };

  function setStatus(message){$('status').textContent=message;}
  function clearError(){$('error').textContent='';$('error').hidden=true;}
  function showError(message){$('error').textContent=message;$('error').hidden=false;}
  function stopStream(){
    const old=stream;stream=null;
    if(old)for(const track of old.getTracks()){track.onended=null;track.stop();}
    video.pause();video.srcObject=null;video.hidden=true;
    window.MirrorDevices?.photoEnded();
  }
  function invalidateResult(){
    window.MirrorTracing?.disable();
    renderRevision++;clearTimeout(debounce);processor.cancel();result=null;
    line.width=1;line.height=1;line.hidden=true;
    $('linePlaceholder').hidden=false;$('resultMeta').textContent='等待确认照片';
    $('processing').hidden=true;$('drawingSurface').setAttribute('aria-busy','false');
    for(const url of downloadableURLs)URL.revokeObjectURL(url);downloadableURLs.clear();
  }
  function clearPhoto(){
    source=null;sourceKind=null;photo.width=1;photo.height=1;photo.hidden=true;
    $('sourceMeta').textContent='等待取景';$('photoPlaceholder').hidden=false;
  }
  function renderControls(){
    const hasDraft=phase==='draft',confirmed=phase==='confirmed';
    $('capture').hidden=!stream;$('capture').disabled=!stream||video.readyState<2||opening;
    $('closeCamera').hidden=!stream;
    $('openCamera').disabled=opening;
    $('openCamera').textContent=opening?'正在打开…':stream?'切换 / 重开':'打开摄像头';
    $('confirm').hidden=!hasDraft;
    $('retake').hidden=!(hasDraft||confirmed);$('retake').textContent=sourceKind==='import'?'重新拍照':'重拍';
    $('detailControls').disabled=!confirmed;$('lineWidth').disabled=!confirmed;
    $('tuningControls').disabled=!confirmed;$('saveLinePreset').disabled=!confirmed;
    $('download').disabled=!result||exporting;
    const current=confirmed?3:hasDraft?2:1;
    for(let i=1;i<=3;i++)if(i===current)$('step'+i).setAttribute('aria-current','step');else $('step'+i).removeAttribute('aria-current');
    $('photoHeading').textContent=stream?'镜头中的你':hasDraft?'确认这一刻':'你的照片';
  }
  function cameraError(error){
    const messages={NotAllowedError:'摄像头权限未获允许，请在浏览器中允许访问，或导入照片。',
      SecurityError:'此页面无法访问摄像头，请通过 localhost 或 127.0.0.1 的静态服务器打开。',
      NotFoundError:'没有找到摄像头，请检查连接，或导入照片。',
      NotReadableError:'无法读取摄像头，可能正被原主程序或其他应用占用，请先关闭占用后重试。',
      AbortError:'摄像头打开中断，请重新连接后重试。',OverconstrainedError:'所选摄像头不可用，请刷新或选择其他摄像头。'};
    return messages[error.name]||'摄像头无法打开：'+(error.message||'请检查设备或导入照片。');
  }
  async function refreshCameras(){
    if(!navigator.mediaDevices?.enumerateDevices)return;
    try{
      const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
      const selected=$('camera').value,active=stream?.getVideoTracks()[0]?.getSettings().deviceId;
      $('camera').replaceChildren(new Option('默认摄像头',''),...devices.map((d,i)=>new Option(d.label||'摄像头 '+(i+1),d.deviceId)));
      $('camera').value=devices.some(d=>d.deviceId===(active||selected))?(active||selected):'';
    }catch(_){/* Permission-free enumeration may fail; direct permission request still works. */}
  }
  async function openCamera(){
    const ticket=++operation;opening=true;clearError();stopStream();invalidateResult();clearPhoto();phase='empty';renderControls();
    setStatus('正在请求摄像头，请在浏览器提示中允许访问。');
    try{
      await window.MirrorDevices?.beforePhoto();
      if(ticket!==operation){window.MirrorDevices?.photoEnded();return;}
      if(!navigator.mediaDevices?.getUserMedia)throw Object.assign(Error(),{name:'SecurityError'});
      const deviceId=$('camera').value;
      const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:960},...(deviceId?{deviceId:{exact:deviceId}}:{})}});
      if(ticket!==operation){next.getTracks().forEach(t=>t.stop());window.MirrorDevices?.photoEnded();return;}
      stream=next;video.srcObject=next;video.hidden=false;$('photoPlaceholder').hidden=true;
      const onEnded=()=>{
        if(stream!==next)return;
        operation++;opening=false;stopStream();phase='empty';clearPhoto();invalidateResult();
        setStatus('摄像头已断开。');showError('画面已中断，请重新连接摄像头，或导入照片。');renderControls();refreshCameras();
      };
      next.getVideoTracks().forEach(track=>track.onended=onEnded);
      await video.play();
      if(ticket!==operation)return;
      await refreshCameras();
      if(ticket!==operation)return;
      $('sourceMeta').textContent='实时预览 · 镜像';$('mirrorNote').textContent='拍照与预览保持相同镜像方向';
      setStatus('调整好位置，在你想留下的一刻点击“拍照”。');
    }catch(error){
      if(ticket!==operation)return;
      stopStream();window.MirrorDevices?.photoEnded();$('photoPlaceholder').hidden=false;setStatus('也可以导入本机照片继续。');showError(cameraError(error));
    }finally{if(ticket===operation){opening=false;renderControls();}}
  }
  function sizeOf(w,h){const scale=Math.min(1,1600/Math.max(w,h));return [Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale))];}
  function draftFrom(image,w,h,mirror,kind){
    invalidateResult();const [width,height]=sizeOf(w,h);photo.width=width;photo.height=height;
    const ctx=photo.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    ctx.save();if(mirror){ctx.translate(width,0);ctx.scale(-1,1);}ctx.drawImage(image,0,0,width,height);ctx.restore();
    source=null;sourceKind=kind;phase='draft';photo.hidden=false;$('photoPlaceholder').hidden=true;
    photo.dataset.sessionId=crypto.randomUUID();
    window.MirrorSensors?.newPhoto();
    $('sourceMeta').textContent=width+' × '+height+(mirror?' · 镜像':'');
    $('mirrorNote').textContent=kind==='camera'?'摄像头已释放 · 镜像照片':'已按照片方向导入';
    setStatus('这是你想留下的一刻吗？确认后生成线稿，也可以重拍或换一张照片。');renderControls();
  }
  function capture(){
    if(!stream||video.readyState<2||!video.videoWidth)return;
    operation++;opening=false;clearError();
    draftFrom(video,video.videoWidth,video.videoHeight,true,'camera');stopStream();window.MirrorDevices?.photoEnded();renderControls();
  }
  async function importPhoto(){
    const file=$('photoFile').files[0];$('photoFile').value='';if(!file)return;
    const ticket=++operation;opening=false;stopStream();window.MirrorDevices?.photoEnded();invalidateResult();clearPhoto();phase='empty';clearError();renderControls();
    setStatus('正在读取照片…');let bitmap=null;
    try{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('请选择 JPEG、PNG 或 WebP 照片。');
      if(file.size>25*1024*1024)throw Error('照片超过 25 MB，请先缩小文件后再导入。');
      // Native decoder applies EXIF orientation before resizing/drawing; do not rotate a second time.
      bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      if(ticket!==operation)return;
      if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>60000000)throw Error('照片尺寸过大或无效，请选择不超过 6000 万像素的照片。');
      draftFrom(bitmap,bitmap.width,bitmap.height,false,'import');
    }catch(error){if(ticket===operation){showError(error.message||'照片无法解码，请换一张 JPEG、PNG 或 WebP 照片。');setStatus('没有读到可用照片，请重新导入或拍照。');}}
    finally{bitmap?.close();if(ticket===operation)renderControls();}
  }
  function confirm(){
    if(phase!=='draft')return;
    source=photo.getContext('2d').getImageData(0,0,photo.width,photo.height);
    phase='confirmed';clearError();renderControls();scheduleRender(0);
  }
  function scheduleRender(delay=120){
    if(phase!=='confirmed'||!source)return;
    clearError();invalidateResult();const ticket=renderRevision;
    $('processing').hidden=false;$('linePlaceholder').hidden=true;
    $('drawingSurface').setAttribute('aria-busy','true');$('resultMeta').textContent='正在生成';
    setStatus('正在从确认照片整理轮廓…');renderControls();
    const options={detail:document.querySelector('input[name="detail"]:checked').value,lineWidth:Number($('lineWidth').value),
      tuning:Object.fromEntries(tuningSpecs.map(({key})=>[key,Number($(key).value)]))};
    debounce=setTimeout(async()=>{
      try{
        const next=await processor.generate(source,options);
        if(ticket!==renderRevision||phase!=='confirmed')return;
        result=next;line.width=next.width;line.height=next.height;
        const layer=document.createElement('canvas');layer.width=next.width;layer.height=next.height;
        layer.getContext('2d').putImageData(next.layer,0,0);
        const ctx=line.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,line.width,line.height);ctx.drawImage(layer,0,0);layer.width=1;
        line.hidden=false;$('resultMeta').textContent=next.width+' × '+next.height+' · '+Math.round(next.processingMs)+' ms';
        window.MirrorTracing?.enable(next.width,next.height,photo.dataset.sessionId);
        setStatus(next.edgePixels?'轮廓已生成。调整细节与线宽，找到适合描摹的底稿。':'这张照片没有提取到足够轮廓。试试“丰富”，或换一张光线和对比更清晰的照片。');
      }catch(error){
        if(ticket!==renderRevision||error.name==='AbortError')return;
        showError(error.message||'线稿生成失败，请重新选择照片。');$('linePlaceholder').hidden=false;$('resultMeta').textContent='生成失败';
        setStatus('可以调整参数重试，或重新拍照、导入。');
      }finally{
        if(ticket===renderRevision){$('processing').hidden=true;$('drawingSurface').setAttribute('aria-busy','false');renderControls();}
      }
    },delay);
  }
  async function download(){
    if(!result||exporting)return;
    const ticket=renderRevision;exporting=true;clearError();renderControls();
    try{
      const blob=await new Promise(resolve=>line.toBlob(resolve,'image/png'));
      if(ticket!==renderRevision)return;
      if(!blob)throw Error('PNG 导出失败，请重试。');
      const url=URL.createObjectURL(blob);downloadableURLs.add(url);
      const a=document.createElement('a');a.href=url;a.download='cyber-mirror_'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>{URL.revokeObjectURL(url);downloadableURLs.delete(url);},30000);
      setStatus('下载已发起，请在浏览器的下载列表中查看线稿。');
    }catch(error){showError(error.message||'下载失败，请重试。');}
    finally{exporting=false;renderControls();}
  }
  $('openCamera').onclick=openCamera;
  $('camera').onchange=()=>{if(stream||opening)openCamera();};
  $('closeCamera').onclick=()=>{operation++;opening=false;stopStream();window.MirrorDevices?.photoEnded();clearPhoto();phase='empty';setStatus('摄像头已关闭，可重新打开或导入照片。');renderControls();};
  $('capture').onclick=capture;$('confirm').onclick=confirm;$('retake').onclick=openCamera;
  $('photoFile').onchange=importPhoto;$('download').onclick=download;
  for(const input of document.querySelectorAll('input[name="detail"]'))input.onchange=()=>{applyPreset();scheduleRender();};
  $('resetTuning').onclick=()=>{applyPreset();scheduleRender();};
  $('lineWidth').oninput=()=>{$('widthValue').textContent=$('lineWidth').value+' px';scheduleRender();};
  video.onloadeddata=()=>renderControls();
  if(navigator.mediaDevices?.addEventListener)navigator.mediaDevices.addEventListener('devicechange',refreshCameras);
  window.addEventListener('pagehide',()=>{operation++;opening=false;stopStream();invalidateResult();clearPhoto();processor.dispose();phase='empty';});
  window.addEventListener('pageshow',event=>{if(event.persisted){setStatus('页面已恢复，请重新拍照或导入。');renderControls();}});
  $('photoFile').addEventListener('focus',()=>document.querySelector('.file-button').classList.add('focused'));
  $('photoFile').addEventListener('blur',()=>document.querySelector('.file-button').classList.remove('focused'));
  refreshCameras();renderControls();
})();
