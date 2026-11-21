/* Reset this tab's participant; never erase saved presets or historical files. */
(() => {
  const button=document.getElementById('nextParticipant');
  button.onclick=async()=>{
    if(button.disabled)return;
    button.disabled=true;
    const status=document.getElementById('participantStatus');
    status.textContent='正在结束本次体验…';
    try{
      const token=document.querySelector('meta[name="mirror-token"]').content;
      const response=await fetch('/api/sensors',{headers:{'X-Mirror-Token':token},signal:AbortSignal.timeout(7000)});
      if(!response.ok)throw Error('无法确认采集状态，请重试。');
      const packet=await response.json();
      if(!packet.connected)throw Error('采集服务未连接，无法确认记录已结束，请恢复连接后重试。');
      if(packet.state?.artwork_running)throw Error('原织锦作品仍在进行，请先在原页面结束该作品。');
      if(packet.state?.recording){
        const stop=await fetch('/api/device/record_stop',{method:'POST',headers:{'X-Mirror-Token':token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
        const result=await stop.json();if(!stop.ok)throw Error(result.error||'记录停止失败，未清除本次画面。');
      }
      // pagehide stops browser media, cancels workers, clears all canvas/input state.
      // A fresh page skips trace history, preserving only explicitly saved local presets.
      window.location.reload();
    }catch(error){status.textContent=error.message||'重置失败，请重试。';button.disabled=false;}
  };
})();
