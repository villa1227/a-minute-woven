/* Independent mirror composition; consumes actual trace rows, never starts recording. */
(function(root){
  const median=xs=>{const s=xs.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  class WovenSession {
    constructor(seed,now=()=>performance.now()/1000){
      this.seed=seed;this.clock=now;this.origin=now();this.bands=[];this.references={left:null,right:null,heart:null};
      this.buckets=Array.from({length:12},()=>({left:[],right:[],heart:[]}));this.streamId=null;this.cursor=0;
    }
    ingest(packet){
      if(!packet.connected||!packet.trace)return;
      const trace=packet.trace;
      if(packet.reset||this.streamId!==trace.stream_id){this.streamId=trace.stream_id;this.cursor=trace.cursor;return;}
      for(const row of trace.rows||[]){
        if(row.seq<=this.cursor)continue;this.cursor=row.seq;
        const age=trace.now_s-row.t,elapsed=this.clock()-this.origin-age;
        if(!Number.isFinite(age)||age<0||elapsed<0||elapsed>=60)continue;
        const index=Math.floor(elapsed/5);if(index<this.bands.length)continue;
        const d=row.data,b=this.buckets[index];
        if(row.source==='camera')for(const [side,key] of [['image_left','left'],['image_right','right']]){
          const e=d.eyes?.[side];if(e?.quality==='candidate_unvalidated'&&Number.isFinite(e.candidate_diameter_px)&&e.candidate_diameter_px>0)b[key].push(e.candidate_diameter_px);
        }
        if(row.source==='heart_rate'&&Number.isFinite(d.bpm)&&d.bpm>0&&d.contact_detected!==false&&!['contact_lost','zero_bpm'].includes(d.quality))b.heart.push(d.bpm);
      }
      this.cursor=Math.max(this.cursor,trace.cursor);
    }
    tick(){
      const elapsed=Math.max(0,this.clock()-this.origin),count=Math.min(12,Math.floor(elapsed/5));
      while(this.bands.length<count){
        const index=this.bands.length,b=this.buckets[index],values=Object.fromEntries(Object.entries(b).map(([k,v])=>[k,v.length?median(v):null]));
        for(const key of Object.keys(values))if(values[key]!==null&&this.references[key]===null)this.references[key]=values[key];
        const amplitude=Object.fromEntries(['left','right'].map(k=>[k,values[k]===null?null:.08+(Math.max(-.3,Math.min(.3,values[k]/this.references[k]-1))+.3)/.6*.16]));
        const delta=values.heart===null?null:Math.max(-20,Math.min(20,values.heart-this.references.heart));
        this.bands.push({index,seed:this.seed+':woven:'+index,values,amplitude,
          counts:Object.fromEntries(Object.entries(b).map(([k,v])=>[k,v.length])),threads:delta===null?22:Math.round(16+(delta+20)/40*24),base_threads:22,empty:Object.values(values).every(v=>v===null)});
        this.buckets[index]={left:[],right:[],heart:[]};
      }
      return Math.min(65,elapsed);
    }
    snapshot(){const elapsed=this.tick();return {renderer:'mirror-woven-v1',seed:this.seed,elapsed_s:elapsed,duration_s:60,display_duration_s:65,preparation_s:5,
      bands:JSON.parse(JSON.stringify(this.bands)),references:{...this.references},status:elapsed>=65?'completed':'running'};}
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={WovenSession};return;}
  const $=id=>document.getElementById(id),canvas=$('wovenCanvas');let session=null,width=0,height=0,seed=null,cache=new Map(),frame=null;
  function draw(snapshot,target=canvas){
    const ctx=target.getContext('2d');ctx.clearRect(0,0,target.width,target.height);
    ctx.fillStyle=Weave.PAPER;ctx.fillRect(0,0,target.width,target.height);
    for(const band of snapshot.bands){
      if(!cache.has(band.index)){
        const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');x.scale(width/Weave.WIDTH,height/Weave.HEIGHT);Weave.drawBand(x,band);cache.set(band.index,c);
      }
      const fraction=Math.max(0,Math.min(1,(snapshot.elapsed_s-5-band.index*5)/5));if(!fraction)continue;
      ctx.save();ctx.beginPath();ctx.rect(160/Weave.WIDTH*width,(150+band.index*210)/Weave.HEIGHT*height,2080/Weave.WIDTH*width*fraction,210/Weave.HEIGHT*height);ctx.clip();ctx.drawImage(cache.get(band.index),0,0);ctx.restore();
    }
  }
  function render(){
    frame=null;
    if(!session)return;
    const snapshot=session.snapshot();
    if($('wovenEnabled').checked){canvas.hidden=false;if(!document.hidden)draw(snapshot);}
    else canvas.hidden=true;
    $('wovenStatus').textContent=(!session?'':snapshot.elapsed_s<5?'织纹准备中 · 5 秒后逐段生长':snapshot.elapsed_s>=65?'woven 已完成 · 可继续涂绘':`woven 生长中 · ${Math.floor(snapshot.elapsed_s)} / 65 秒`)+(!$('wovenEnabled').checked?'（已隐藏，计时继续）':'');
    if(snapshot.elapsed_s<65)frame=requestAnimationFrame(render);
  }
  function ensure(){if(width&&$('wovenEnabled').checked&&!session){session=new WovenSession(seed);cache.clear();}if(frame===null)render();}
  $('wovenEnabled').onchange=()=>{ensure();canvas.hidden=!$('wovenEnabled').checked||!session;};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&session){if(frame!==null)cancelAnimationFrame(frame);frame=null;render();}});
  window.MirrorWoven={
    freeze(){if(session){const elapsed=session.tick();session.clock=()=>session.origin+elapsed;if(frame!==null)cancelAnimationFrame(frame);frame=null;render();}},
    setup(w,h,id){this.clear();width=w;height=h;seed=id;canvas.width=w;canvas.height=h;ensure();},
    clear(){if(frame!==null)cancelAnimationFrame(frame);frame=null;session=null;width=height=0;cache.clear();canvas.width=canvas.height=1;canvas.hidden=true;$('wovenStatus').textContent='开启后自动织入 60 秒数据，约 65 秒完成；缺失数据仍有基础织纹。';},
    ingest(packet){session?.ingest(packet);},
    compose(ctx){if(session&&$('wovenEnabled').checked){draw(session.snapshot());ctx.drawImage(canvas,0,0);}},
    export(){return {included:$('wovenEnabled').checked&&!!session,artwork:session?.snapshot()??null};}
  };
})(globalThis);
