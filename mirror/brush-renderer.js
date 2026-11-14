/* Deterministic distance-spaced marks. Interpolation here renders ink, never samples. */
(function(root){
  function hash(text){let h=2166136261;for(const c of text){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
  function random(seed,index){let x=(seed+Math.imul(index+1,374761393))>>>0;x=Math.imul(x^(x>>>13),1274126177);return ((x^(x>>>16))>>>0)/4294967296;}
  class BrushRenderer {
    constructor(ctx,seed='mirror'){this.ctx=ctx;this.seed=hash(seed);this.breakPath();}
    breakPath(){this.previous=null;this.distance=0;this.nextMark=0;this.mark=0;}
    stamp(x,y,angle,time,brush,stroke){
      const ctx=this.ctx,seed=this.seed^hash(String(stroke)),r=brush.width/2;
      const texture=Math.max(1,Math.min(5,brush.textureStrength||1));
      const offset=brush.wobble*Math.sin(time/1000*2*Math.PI*brush.frequency);
      x-=Math.sin(angle)*offset;y+=Math.cos(angle)*offset;
      const color=brush.color.map(v=>Math.round(v)).join(','),blur=brush.softness+(1-brush.hardness)*1.5;
      // Compensate repeated 0.5 px stamp overlap so transparency stays perceptible.
      const inkAlpha=1-Math.pow(1-brush.opacity,.5/Math.max(.5,brush.width));
      ctx.save();ctx.globalAlpha=inkAlpha;ctx.fillStyle=`rgb(${color})`;
      if(blur>.01){ctx.shadowColor=`rgba(${color},0.35)`;ctx.shadowBlur=blur;}
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
      if(brush.family==='fiber'){
        ctx.globalAlpha=inkAlpha*Math.min(.8,.18*texture);
        for(let i=0;i<2;i++){const d=(random(seed,this.mark*5+i)-.5)*brush.width*(1.8+.35*(texture-1));
          ctx.beginPath();ctx.ellipse(x-Math.sin(angle)*d,y+Math.cos(angle)*d,r*.9,.22+.18*(texture-1),angle,0,Math.PI*2);ctx.fill();}
      }else if(brush.family==='grain'){
        ctx.globalAlpha=inkAlpha*Math.min(1,.25*texture);
        const a=random(seed,this.mark*5)*Math.PI*2,d=r+random(seed,this.mark*5+1)*(.9+(texture-1));
        ctx.beginPath();ctx.arc(x+Math.cos(a)*d,y+Math.sin(a)*d,.25+.3*(texture-1),0,Math.PI*2);ctx.fill();
      }
      ctx.restore();this.mark++;
    }
    draw(sample,brush){
      if(!sample.contact||sample.outside){this.breakPath();return;}
      const previous=this.previous;
      if(!previous||previous.strokeId!==sample.strokeId){this.breakPath();this.previous=sample;this.stamp(sample.x,sample.y,0,sample.eventTimeMs,brush,sample.strokeId);this.nextMark=.5;return;}
      const dx=sample.x-previous.x,dy=sample.y-previous.y,length=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
      if(length>0){
        while(this.nextMark<=this.distance+length){
          const u=(this.nextMark-this.distance)/length;
          this.stamp(previous.x+dx*u,previous.y+dy*u,angle,previous.eventTimeMs+(sample.eventTimeMs-previous.eventTimeMs)*u,brush,sample.strokeId);
          this.nextMark+=.5;
        }
        this.distance+=length;
      }
      this.previous=sample;
    }
  }
  function replay(ctx,document){
    if(document.schemaVersion!==2)throw Error('描摹重绘需要 v2 输入文件');
    const renderer=new BrushRenderer(ctx,document.renderSeed);
    for(const segment of document.segments){
      if(segment.kind==='break')renderer.breakPath();
      else renderer.draw(document.samples[segment.sampleIndex],segment.brush);
    }
  }
  BrushRenderer.replay=replay;
  if(typeof module!=='undefined'&&module.exports)module.exports={BrushRenderer};else root.BrushRenderer=BrushRenderer;
})(globalThis);
