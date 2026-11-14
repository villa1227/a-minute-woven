/* Pure signal/reference/mapping state. Raw sensor values are never rewritten. */
(function(root){
  const VERSION='expressive-four-channel-v2',clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const PALETTE=Object.freeze({happy:[183,132,51],sad:[55,76,135],angry:[161,73,57],fearful:[119,102,140],
    surprised:[50,132,126],disgust:[112,120,63],neutral:[54,61,62]});
  const BASE=Object.freeze({color:[54,61,62],width:2,opacity:.85,softness:0,hardness:1,wobble:0,frequency:0,family:'round'});
  const VIVID={happy:[228,148,20],sad:[40,74,204],angry:[213,47,32],fearful:[143,65,185],surprised:[10,164,141],disgust:[116,145,25],neutral:[54,61,62]};
  const specs={left:[2,1,3],right:[2,1,3],heart:[5,5,2],eda:[1,1,20]}; // ttl, median window, reference count
  const finite=x=>typeof x==='number'&&Number.isFinite(x),positive=x=>finite(x)&&x>0;
  const median=xs=>{const s=xs.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  class BrushMapping {
    constructor(now=()=>performance.now()/1000){
      this.clock=now;this.enabled=true;this.reverseEda=false;this.intensity=3;this.connected=false;this.streamId=null;this.cursor=0;
      this.serverNow=0;this.received=now();this.state={};this.reset();this.current={...BASE,color:BASE.color.slice()};this.updated=now();
    }
    reset(keys=Object.keys(specs)){
      if(!this.channels)this.channels={};
      for(const key of keys)this.channels[key]={points:[],ref:null,latest:null};
      if(keys.length===4){this.expression=null;this.expressionHistory=[];this.candidate=null;this.family='round';this.edaIdentity=null;}
    }
    now(){return this.serverNow+Math.max(0,this.clock()-this.received);}
    disconnect(){this.connected=false;this.family='round';this.candidate=null;}
    ingest(packet){
      if(!packet.connected||!packet.trace){this.disconnect();return;}
      const trace=packet.trace;
      if(packet.reset||this.streamId!==trace.stream_id){this.reset();this.cursor=trace.cursor;}
      this.streamId=trace.stream_id;this.serverNow=trace.now_s;this.received=this.clock();this.connected=true;
      this.state=packet.state||{};
      for(const row of trace.rows||[]){
        if(row.seq<=this.cursor)continue;
        this.cursor=row.seq;
        const d=row.data,t=row.t;
        if(!finite(t))continue;
        if(row.source==='event'){
          const kind=d.kind;
          if(kind==='camera_reset')this.reset(['left','right']);
          else if(kind==='camera_roi_changed')this.reset(d.side==='both'?['left','right']:[d.side==='image_left'?'left':'right']);
          else if(kind==='heart_reset')this.reset(['heart']);
          else if(kind==='eda_reset'){this.reset(['eda']);this.edaIdentity=null;}
        }else if(row.source==='camera'){
          for(const [side,key] of [['image_left','left'],['image_right','right']]){
            const e=d.eyes?.[side];this.add(key,t,e?.quality==='candidate_unvalidated'&&positive(e.candidate_diameter_px)?e.candidate_diameter_px:null);
          }
        }else if(row.source==='heart_rate')this.add('heart',t,positive(d.bpm)&&d.contact_detected!==false&&!['contact_lost','zero_bpm'].includes(d.quality)?d.bpm:null);
        else if(row.source==='eda'){
          const identity=JSON.stringify([d.stream_id,d.segment]);
          if(this.edaIdentity!==null&&identity!==this.edaIdentity)this.reset(['eda']);
          this.edaIdentity=identity;
          this.add('eda',t,d.quality==='received_unvalidated'&&Number.isInteger(d.adc)&&d.adc>=0&&d.adc<=1023?d.adc:null);
        }else if(row.source==='expression')this.readExpression(d,t);
      }
      this.cursor=Math.max(this.cursor,trace.cursor);
      // Data removed by devices must invalidate the visual, even with buffered old rows.
      if(!this.state.camera_alive){this.channels.left.latest=null;this.channels.right.latest=null;}
      if(!this.state.heart_alive)this.channels.heart.latest=null;
      if(!this.state.eda?.connected)this.channels.eda.latest=null;
      if(!this.state.expression?.running||!this.state.expression?.fresh){this.expression=null;this.candidate=null;this.family='round';}
    }
    add(key,t,value){
      const c=this.channels[key];
      if(c.latest&&t<c.latest.t)return;
      c.latest={t,value};
      if(value!==null)c.points.push({t,value});
      c.points=c.points.filter(p=>p.t>=this.now()-5);
    }
    readExpression(d,t){
      if(this.expression&&t<this.expression.t)return;
      const scores=d.scores,keys=Object.keys(PALETTE);
      if(d.quality!=='classified_unvalidated'||!scores||!keys.every(k=>finite(scores[k])&&scores[k]>=0)||!positive(keys.reduce((s,k)=>s+scores[k],0))){
        this.expression=null;this.candidate=null;this.family='round';return;
      }
      const sum=keys.reduce((s,k)=>s+scores[k],0),normalized=Object.fromEntries(keys.map(k=>[k,scores[k]/sum]));
      const label=keys.reduce((a,b)=>normalized[a]>normalized[b]?a:b);
      this.expression={t,scores:normalized};
      if(normalized[label]<.45){this.candidate=null;this.family='round';return;}
      if(this.candidate?.label!==label||t-this.candidate.last>1)this.candidate={label,start:t,last:t};
      else this.candidate.last=t;
      if(t-this.candidate.start>=1)this.family=['happy','neutral'].includes(label)?'round':['sad','fearful'].includes(label)?'fiber':'grain';
      else this.family='round';
    }
    value(key){
      const c=this.channels[key],[ttl,window]=specs[key],now=this.now();
      if(!this.connected||!c.latest||c.latest.value===null||now-c.latest.t>=ttl||now<c.latest.t)return null;
      const points=c.points.filter(p=>now-p.t<=window&&now>=p.t);
      return points.length?median(points.map(p=>p.value)):null;
    }
    setReference(){
      const now=this.now();
      for(const [key,c] of Object.entries(this.channels)){
        const points=c.points.filter(p=>now-p.t<=5&&now>=p.t);
        c.ref=this.value(key)!==null&&points.length>=specs[key][2]?median(points.map(p=>p.value)):null;
      }
      return this.references();
    }
    references(){return Object.fromEntries(Object.entries(this.channels).map(([k,c])=>[k,c.ref]));}
    target(){
      const gain=clamp(Number.isFinite(this.intensity)?this.intensity:3,1,5),extra=gain-1;
      const out={...BASE,color:BASE.color.slice(),intensity:gain,textureStrength:gain};if(!this.enabled)return {...out,color:[0,0,0],opacity:1,textureStrength:1};
      const eyes=['left','right'].flatMap(key=>{const v=this.value(key),r=this.channels[key].ref;return v!==null&&positive(r)?[clamp(v/r-1,-.3,.3)]:[];});
      if(eyes.length){const change=clamp(eyes.reduce((a,b)=>a+b,0)/eyes.length*gain,-.3,.3),u=(change+.3)/.6;
        out.width=1.5+.75*extra+u*(2.5+5.25*extra);out.hardness=.9-u*Math.min(.7,.3+.125*extra);}
      const eda=this.value('eda'),ref=this.channels.eda.ref;
      if(eda!==null&&finite(ref)){const u=(clamp((eda-ref)*(this.reverseEda?-1:1)*gain,-100,100)+100)/200;
        out.opacity=Math.min(.98,.9+.025*extra)-Math.min(.75,.3+.15*extra)*u;out.softness=1.5*gain*u;}
      const heart=this.value('heart'),hr=this.channels.heart.ref;
      if(heart!==null&&positive(hr)){out.wobble=(clamp((heart-hr)*gain,-20,20)+20)/40*(.8+2.4*extra);out.frequency=heart/60;}
      const expression=this.expression;
      if(this.connected&&expression&&this.now()-expression.t<1){
        const vivid=clamp(extra/2,0,1);
        out.color=[0,1,2].map(i=>Object.keys(PALETTE).reduce((sum,k)=>sum+(PALETTE[k][i]+(VIVID[k][i]-PALETTE[k][i])*vivid)*expression.scores[k],0));out.family=this.family;
      }
      return out;
    }
    brush(){
      const now=this.clock(),target=this.target(),alpha=1-Math.exp(-Math.max(0,now-this.updated)/.5);this.updated=now;
      if(!this.enabled)this.current=target;
      else for(const key of ['width','opacity','softness','hardness','wobble','frequency'])this.current[key]+=(target[key]-this.current[key])*alpha;
      if(this.enabled)this.current.color=this.current.color.map((v,i)=>v+(target.color[i]-v)*alpha);
      this.current.family=target.family;
      this.current.intensity=target.intensity;this.current.textureStrength=target.textureStrength;
      return {...this.current,color:this.current.color.slice(),mappingVersion:VERSION};
    }
    diagnostics(){return Object.fromEntries(Object.keys(specs).map(k=>[k,{value:this.value(k),reference:this.channels[k].ref}]));}
  }
  const api={BrushMapping,BASE,PALETTE,VERSION};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BioBrush=api;
})(globalThis);
