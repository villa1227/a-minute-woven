/* Per-tab settings for the background edition. Shared mapping stays untouched. */
(() => {
  const $=id=>document.getElementById(id);
  function adapt(brush){
    const mapping=window.MirrorSensors?.mapping,diag=mapping?.diagnostics();
    const eyeActive=!!diag&&['left','right'].some(key=>diag[key].value!==null&&diag[key].reference>0);
    const canvas=$('lineCanvas');
    return BackgroundBrush.adapt(brush,{longestSide:Math.max(1,canvas.width,canvas.height),
      diameterPercent:Number($('backgroundDiameter').value),eyeActive,mappingEnabled:$('mappingEnabled').checked});
  }
  function readout(brush){
    $('backgroundSizeStatus').textContent=$('lineCanvas').hidden?'生成线稿后可绘制背景':
      `基础 ${brush.baseDiameter.toFixed(1)} px · 当前 ${brush.width.toFixed(0)} px${brush.eyeActive&&brush.mappingEnabled?' · 眼部调节中':' · 基础直径'}`;
  }
  $('backgroundDiameter').oninput=()=>{
    $('backgroundDiameterValue').textContent=$('backgroundDiameter').value+'%';
    if(window.MirrorSensors)readout(adapt(MirrorSensors.brush()));
  };
  function opacity(){return Number($('backgroundOpacity').value)/100;}
  function updateOpacity(){
    $('backgroundOpacityValue').textContent=$('backgroundOpacity').value+'%';
    $('backgroundCanvas').style.opacity=String(opacity());
  }
  $('backgroundOpacity').oninput=updateOpacity;updateOpacity();
  window.MirrorBackground={adapt,readout,opacity};
})();
