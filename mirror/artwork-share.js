/* Final edition only. Freeze once, retry the same PNG, show only the current result. */
(() => {
  const $=id=>document.getElementById(id),button=$('shareArtwork');
  let frozen=null,uploading=false,downloadURL=null,ready=false;
  function freeze(){
    if(frozen)return;
    document.activeElement?.blur();
    window.MirrorWoven?.freeze();
    const canvas=MirrorBackgroundComposition.compose(true);
    frozen={canvas,blob:null};
    const preview=$('finishedPreview');preview.width=canvas.width;preview.height=canvas.height;preview.getContext('2d').drawImage(canvas,0,0);preview.hidden=false;
    $('drawingSurface').hidden=true;$('artworkCaption').hidden=true;
    document.body.dataset.artworkFinished='true';
    document.querySelector('.intro h1').textContent='这一刻，成为你的作品。';
    document.querySelector('.intro>p:last-child').textContent='保存作品，或扫码把它带走。准备好后，开始下一位体验。';
    $('resultMeta').textContent='已定格 · '+canvas.width+' × '+canvas.height;
    // Keep local downloads and next-participant available; prevent further edits.
    const keep=new Set(['nextParticipant','downloadArtwork','downloadTracing','downloadInput','download','shareArtwork','downloadFinished']);
    for(const element of document.querySelectorAll('input,select,button'))if(!keep.has(element.id))element.disabled=true;
    $('tracingCanvas').style.pointerEvents='none';
  }
  async function share(){
    if(uploading||!$('shareConsent').checked)return;
    try{
      freeze();uploading=true;button.disabled=true;
      $('shareResult').hidden=true;$('shareStatus').textContent='作品已定格，正在上传 ImgLoc…';
      if(!frozen.blob)frozen.blob=await new Promise(resolve=>frozen.canvas.toBlob(resolve,'image/png'));
      if(!frozen.blob)throw Error('作品导出失败，请使用本地下载。');
      const token=document.querySelector('meta[name="mirror-token"]').content;
      const response=await fetch('/api/share/upload',{method:'POST',headers:{'X-Mirror-Token':token,'Content-Type':'image/png'},body:frozen.blob,signal:AbortSignal.timeout(55000)});
      const result=await response.json();if(!response.ok)throw Error(result.error||'分享失败');
      if(!/^https:\/\/i\.imgs\.ovh\/[a-zA-Z0-9/_-]+\.png$/.test(result.url))throw Error('分享链接格式无效');
      const code=qrcode(0,'M');code.addData(result.url);code.make();
      const qr=$('shareQr'),count=code.getModuleCount(),scale=Math.max(4,Math.floor(280/(count+8)));
      qr.width=qr.height=(count+8)*scale;const ctx=qr.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,qr.width,qr.height);ctx.fillStyle='black';
      for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(code.isDark(y,x))ctx.fillRect((x+4)*scale,(y+4)*scale,scale,scale);
      $('shareLink').href=result.url;$('shareLink').textContent=result.url;
      $('shareResult').hidden=false;$('shareStatus').textContent='扫码带走这幅作品。'+result.retention;
      $('artworkShare').scrollIntoView({behavior:'smooth',block:'nearest'});
      button.textContent='二维码已生成';
      window.MirrorShare.completed=true;
    }catch(error){$('shareStatus').textContent=(error.name==='TimeoutError'?'上传超时，可重试同一份作品。':error.message)+' 也可先本地下载定格作品。';button.textContent='重试生成二维码';}
    finally{uploading=false;button.disabled=window.MirrorShare.completed||!$('shareConsent').checked;}
  }
  $('downloadFinished').onclick=()=>{
    if(!frozen)return;
    frozen.canvas.toBlob(blob=>{if(!blob)return;if(downloadURL)URL.revokeObjectURL(downloadURL);downloadURL=URL.createObjectURL(blob);const a=document.createElement('a');a.href=downloadURL;a.download='mirror-finished.png';a.click();},'image/png');
  };
  button.onclick=share;
  $('shareConsent').onchange=()=>{button.disabled=!ready||!$('shareConsent').checked||uploading||window.MirrorShare.completed;};
  window.MirrorShare={completed:false,ready(value){ready=value;if(!frozen)button.disabled=!ready||!$('shareConsent').checked;},get frozen(){return !!frozen;}};
  window.addEventListener('pagehide',()=>{if(downloadURL)URL.revokeObjectURL(downloadURL);frozen=null;});
})();
