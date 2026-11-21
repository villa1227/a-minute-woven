/* Cached broad brush for the background edition. Does not modify legacy brushes. */
(function(root){
  const VERSION='background-stamps-v2';
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function hash(text){let h=2166136261;for(const c of String(text)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
  function random(seed,index){let x=(seed+Math.imul(index+1,374761393))>>>0;x=Math.imul(x^(x>>>13),1274126177);return ((x^(x>>>16))>>>0)/4294967296;}
  const round=(v,step)=>Math.round(v/step)*step;
  function adapt(brush,{longestSide,diameterPercent=6,eyeActive=false,mappingEnabled=true}={}){
    if(!Number.isFinite(longestSide)||longestSide<1||!Number.isFinite(diameterPercent)||diameterPercent<2||diameterPercent>16)throw Error('背景笔刷尺寸无效');
    const baseDiameter=longestSide*diameterPercent/100;
    const ratio=mappingEnabled&&eyeActive?clamp(brush.width/9.5,.5,2):1;
    const width=Math.max(1,round(baseDiameter*ratio,1));
    const actual={...brush,color:brush.color.map(v=>clamp(Math.round(v),0,255)),width,
      baseDiameter,diameterPercent,diameterRatio:ratio,eyeActive:!!eyeActive,mappingEnabled,
      renderer:VERSION,softness:round(clamp(brush.softness/7.5,0,1)*width*.12,.5),
      opacity:clamp(round(brush.opacity*.4,.025),.025,.4),hardness:clamp(round(brush.hardness,.05),.1,1),
      textureStrength:clamp(round(brush.textureStrength||1,.5),1,5)};
    if(!mappingEnabled)Object.assign(actual,{color:[54,61,62],opacity:.3,hardness:1,softness:0,
      wobble:0,frequency:0,family:'round',textureStrength:1});
    return actual;
  }

  class BackgroundBrushRenderer {
    constructor(ctx,seed='background',makeCanvas=()=>document.createElement('canvas')){
      this.ctx=ctx;this.seed=hash(seed);this.makeCanvas=makeCanvas;this.cache=new Map();this.cacheBuilds=0;this.breakPath();
    }
    breakPath(){this.previous=null;this.distance=0;this.nextMark=0;}
    tile(brush){
      const key=JSON.stringify([brush.width,brush.color,brush.opacity,brush.softness,brush.hardness,brush.family,brush.textureStrength]);
      if(this.cache.has(key)){const tile=this.cache.get(key);this.cache.delete(key);this.cache.set(key,tile);return tile;}
      const radius=brush.width/2,feather=clamp(brush.softness+(1-brush.hardness)*radius*.5,0,radius*.8);
      const padding=Math.ceil(feather+3),size=Math.ceil(brush.width+2*padding),center=size/2;
      const canvas=this.makeCanvas();canvas.width=canvas.height=size;const ctx=canvas.getContext('2d');
      const spacing=clamp(brush.width*.1,2,12);
      const alpha=1-Math.pow(1-brush.opacity,spacing/Math.max(spacing,brush.width));
      const rgb=brush.color.join(',');
      if(feather>.01){
        const gradient=ctx.createRadialGradient(center,center,Math.max(0,radius-feather),center,center,radius+feather);
        gradient.addColorStop(0,`rgba(${rgb},${alpha})`);gradient.addColorStop(1,`rgba(${rgb},0)`);ctx.fillStyle=gradient;
      }else ctx.fillStyle=`rgba(${rgb},${alpha})`;
      ctx.beginPath();ctx.arc(center,center,radius+feather,0,Math.PI*2);ctx.fill();
      const strength=brush.textureStrength||1,textureSeed=this.seed^hash(brush.family);
      ctx.save();ctx.beginPath();ctx.arc(center,center,radius,0,Math.PI*2);ctx.clip();
      if(brush.family==='fiber'){
        ctx.globalCompositeOperation='destination-out';ctx.strokeStyle=`rgba(0,0,0,${.12+.04*strength})`;
        ctx.lineWidth=Math.max(.5,brush.width*.006);
        for(let i=0;i<16+strength*4;i++){
          const x=center-radius+random(textureSeed,i)*brush.width;
          ctx.beginPath();ctx.moveTo(x,center-radius);ctx.lineTo(x+brush.width*.12,center+radius);ctx.stroke();
        }
      }else if(brush.family==='grain'){
        ctx.globalCompositeOperation='destination-out';ctx.fillStyle=`rgba(0,0,0,${.1+.035*strength})`;
        for(let i=0;i<80+strength*20;i++){
          const angle=random(textureSeed,i*3)*Math.PI*2,d=Math.sqrt(random(textureSeed,i*3+1))*radius;
          ctx.beginPath();ctx.arc(center+Math.cos(angle)*d,center+Math.sin(angle)*d,
            Math.max(.6,brush.width*(.004+.006*random(textureSeed,i*3+2))),0,Math.PI*2);ctx.fill();
        }
      }
      ctx.restore();
      const tile={canvas,center,spacing};this.cache.set(key,tile);this.cacheBuilds++;
      if(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);
      return tile;
    }
    stamp(x,y,angle,time,brush){
      const tile=this.tile(brush),offset=brush.wobble*Math.sin(time/1000*2*Math.PI*brush.frequency);
      this.ctx.drawImage(tile.canvas,x-Math.sin(angle)*offset-tile.center,y+Math.cos(angle)*offset-tile.center);
      return tile.spacing;
    }
    draw(sample,brush){
      if(!sample.contact||sample.outside){this.breakPath();return;}
      const p=this.previous;
      if(!p||p.strokeId!==sample.strokeId){
        this.breakPath();this.previous=sample;
        this.nextMark=this.stamp(sample.x,sample.y,0,sample.eventTimeMs,brush);return;
      }
      const dx=sample.x-p.x,dy=sample.y-p.y,length=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
      if(length>0){
        while(this.nextMark<=this.distance+length){
          const u=(this.nextMark-this.distance)/length;
          this.nextMark+=this.stamp(p.x+dx*u,p.y+dy*u,angle,p.eventTimeMs+(sample.eventTimeMs-p.eventTimeMs)*u,brush);
        }
        this.distance+=length;
      }
      this.previous=sample;
    }
    static replay(ctx,data,makeCanvas){
      if(data.schemaVersion!==2||![VERSION,'background-stamps-v1'].includes(data.renderer))throw Error('不是背景版输入文件');
      const renderer=new BackgroundBrushRenderer(ctx,data.renderSeed,makeCanvas);
      for(const segment of data.segments){
        if(segment.kind==='break')renderer.breakPath();
        else renderer.draw(data.samples[segment.sampleIndex],segment.brush);
      }
      return renderer;
    }
  }
  const api={BackgroundBrushRenderer,adapt,VERSION};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BackgroundBrush=api;
})(globalThis);
