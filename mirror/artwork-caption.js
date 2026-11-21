/* Signature sits outside the photograph area; deterministic once the work is created. */
(() => {
  function timestamp(date){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);}
  function height(width){return Math.max(64,Math.round(width*.12));}
  function draw(ctx,width,imageHeight,createdAt){
    const footer=height(width);ctx.save();ctx.fillStyle='#fff';ctx.fillRect(0,imageHeight,width,footer);
    ctx.strokeStyle='#e1e2dc';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(width*.08,imageHeight+8);ctx.lineTo(width*.92,imageHeight+8);ctx.stroke();
    ctx.textAlign='center';ctx.fillStyle='#778278';ctx.font=`${Math.max(5,Math.round(width*.022))}px monospace`;
    ctx.fillText(timestamp(new Date(createdAt))+'  UTC+08:00',width/2,imageHeight+footer*.43);
    ctx.fillStyle='#28463e';ctx.font=`${Math.max(9,Math.round(width*.043))}px Georgia, serif`;
    ctx.fillText('Cyber Mirror',width/2,imageHeight+footer*.8);ctx.restore();
  }
  window.ArtworkCaption={height,draw,timestamp};
})();
