(() => {
  const labels = {angry:'愤怒',disgust:'厌恶',fearful:'恐惧',happy:'高兴',neutral:'中性',sad:'悲伤',surprised:'惊讶'};
  const quality = {no_face:'未检测到人脸',multiple_faces:'检测到多人，请保持仅一人入镜',classified_unvalidated:'模型表情分类，未经验证'};
  const bars = document.getElementById('expressionBars');
  const items = Object.entries(labels).map(([key, label]) => {
    const row = document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:42px 1fr 52px;gap:10px;align-items:center;margin:5px 0';
    const name=document.createElement('span'), meter=document.createElement('meter'), value=document.createElement('span');
    name.textContent=label;meter.min=0;meter.max=1;meter.value=0;meter.style.width='100%';meter.setAttribute('aria-label',label+'模型分数');value.textContent='—';
    row.append(name,meter,value);bars.append(row);return {key,meter,value};
  });
  document.getElementById('expressionStart').onclick=()=>api('expression_start',{rate:Number(document.getElementById('expressionRate').value)});
  document.getElementById('expressionStop').onclick=()=>api('expression_stop');
  window.ExpressionPanel={render(state) {
    const e=state.expression;if(!e)return;
    const s=e.sample, valid=e.fresh&&s?.quality==='classified_unvalidated';
    document.getElementById('expressionStart').disabled=!state.camera_alive||e.running||state.recording||state.artwork_running;
    document.getElementById('expressionRate').disabled=e.running||state.recording||state.artwork_running;
    document.getElementById('expressionStop').disabled=!e.running;
    document.getElementById('expressionLabel').textContent=valid?labels[s.label]||'—':'—';
    document.getElementById('expressionStatus').textContent=e.error||(!e.running?'表情识别未开启':e.state==='loading'?'正在加载本机模型…':!e.fresh?'等待新鲜画面 / 结果过期':quality[s?.quality]||'等待识别');
    const fmt=x=>Number.isFinite(x)?x.toFixed(1):'—';
    document.getElementById('expressionTiming').textContent=e.running&&s?'实际 '+fmt(s.observed_hz)+' Hz · 推理 '+fmt(s.processing_ms)+' ms · 帧龄 '+fmt(e.age_s*1000)+' ms':'';
    for(const {key,meter,value} of items){const score=valid?s.scores?.[key]:null;meter.value=score??0;value.textContent=Number.isFinite(score)?(score*100).toFixed(1)+'%':'—';}
  }};
})();
