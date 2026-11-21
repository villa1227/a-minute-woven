/* Pure CPU image processing; shared by the browser worker and Node checks. */
(function(root) {
  'use strict';
  const VERSION='contour-canny-v2';
  const PRESETS=Object.freeze(Object.fromEntries(Object.entries({
    minimal:{sigma:2.5,percentile:.82,minHigh:35,minComponent:60,lowRatio:.5},
    simple:{sigma:1.7,percentile:.64,minHigh:24,minComponent:24,lowRatio:.4},
    standard:{sigma:1.5,percentile:.85,minHigh:20,minComponent:15,lowRatio:.4},
    rich:{sigma:1.05,percentile:.70,minHigh:18,minComponent:12,lowRatio:.4}
  }).map(([key,value])=>[key,Object.freeze(value)])));
  const RANGES=Object.freeze({sigma:Object.freeze([.5,5]),percentile:Object.freeze([.1,.99]),
    minHigh:Object.freeze([1,512]),minComponent:Object.freeze([0,300]),lowRatio:Object.freeze([.1,.9])});

  function resolveParameters(options={}) {
    const detail=options.detail??'standard',lineWidth=options.lineWidth??1;
    if(!Object.hasOwn(PRESETS,detail)||!Number.isInteger(lineWidth)||lineWidth<1||lineWidth>4)
      throw Error('线稿参数无效');
    const tuning=options.tuning??{};
    if(typeof tuning!=='object'||Array.isArray(tuning))throw Error('手动参数无效');
    for(const [key,value] of Object.entries(tuning)){
      const range=RANGES[key];
      if(!range||!Number.isFinite(value)||value<range[0]||value>range[1]||
          (['minHigh','minComponent'].includes(key)&&!Number.isInteger(value)))throw Error('手动参数超出范围：'+key);
    }
    return {detail,lineWidth,...PRESETS[detail],...tuning};
  }

  function smooth(gray,w,h,sigma) {
    const radius=Math.ceil(sigma*2.5),kernel=new Float32Array(radius*2+1);
    let sum=0;
    for(let x=-radius;x<=radius;x++){const v=Math.exp(-x*x/(2*sigma*sigma));kernel[x+radius]=v;sum+=v;}
    for(let i=0;i<kernel.length;i++)kernel[i]/=sum;
    const temp=new Float32Array(w*h),out=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let value=0;for(let k=-radius;k<=radius;k++)value+=gray[y*w+Math.max(0,Math.min(w-1,x+k))]*kernel[k+radius];
      temp[y*w+x]=value;
    }
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let value=0;for(let k=-radius;k<=radius;k++)value+=temp[Math.max(0,Math.min(h-1,y+k))*w+x]*kernel[k+radius];
      out[y*w+x]=value;
    }
    return out;
  }

  function generate(image,options={}) {
    const {width:w,height:h,data}=image,preset=resolveParameters(options),{lineWidth}=preset;
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>1600||h>1600||!data||data.length!==w*h*4)
      throw Error('图像尺寸或像素数据无效，最长边应不超过 1600 像素');
    const n=w*h,gray=new Float32Array(n);
    for(let i=0;i<n;i++){
      const a=data[i*4+3]/255;
      gray[i]=(data[i*4]*.299+data[i*4+1]*.587+data[i*4+2]*.114)*a+255*(1-a);
    }
    const blurred=smooth(gray,w,h,preset.sigma),magnitude=new Float32Array(n),direction=new Uint8Array(n);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,a=blurred[i-w-1],b=blurred[i-w],c=blurred[i-w+1],d=blurred[i-1],e=blurred[i+1],f=blurred[i+w-1],g=blurred[i+w],j=blurred[i+w+1];
      const gx=-a+c-2*d+2*e-f+j,gy=-a-2*b-c+f+2*g+j;
      magnitude[i]=Math.hypot(gx,gy);
      let angle=Math.atan2(gy,gx)*180/Math.PI;if(angle<0)angle+=180;
      direction[i]=angle<22.5||angle>=157.5?0:angle<67.5?1:angle<112.5?2:3;
    }
    const suppressed=new Float32Array(n),hist=new Uint32Array(1444);
    let count=0;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,m=magnitude[i],d=direction[i],offset=d===0?1:d===1?w+1:d===2?w:w-1;
      if(m>=magnitude[i-offset]&&m>=magnitude[i+offset]&&m>=preset.minHigh*preset.lowRatio){
        suppressed[i]=m;hist[Math.min(1443,Math.floor(m))]++;count++;
      }
    }
    let high=preset.minHigh,acc=0;
    for(let i=0;i<hist.length;i++){acc+=hist[i];if(count&&acc>=count*preset.percentile){high=Math.max(high,i);break;}}
    const low=high*preset.lowRatio,visited=new Uint8Array(n),edges=new Uint8Array(n),queue=new Int32Array(n);
    let edgePixels=0;
    // Follow weak edges from strong ones; remove whole short connected components.
    const minimum=Math.max(4,Math.round(preset.minComponent*Math.min(1,Math.max(w,h)/1000)));
    for(let i=0;i<n;i++){
      if(visited[i]||suppressed[i]<high)continue;
      let head=0,tail=1;queue[0]=i;visited[i]=1;
      while(head<tail){
        const p=queue[head++],x=p%w,y=Math.floor(p/w);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if((!dx&&!dy)||x+dx<1||x+dx>=w-1||y+dy<1||y+dy>=h-1)continue;
          const next=p+dy*w+dx;
          if(!visited[next]&&suppressed[next]>=low){visited[next]=1;queue[tail++]=next;}
        }
      }
      if(tail>=minimum)for(let k=0;k<tail;k++){edges[queue[k]]=1;edgePixels++;}
    }
    const pixels=new Uint8ClampedArray(n*4),radius=(lineWidth-1)/2,reach=Math.ceil(radius);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(edges[y*w+x]){
      for(let dy=-reach;dy<=reach;dy++)for(let dx=-reach;dx<=reach;dx++){
        const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;
        const alpha=Math.round(Math.max(0,Math.min(1,radius+1-Math.hypot(dx,dy)))*255),i=(yy*w+xx)*4+3;
        if(alpha>pixels[i])pixels[i]=alpha;
      }
    }
    return {width:w,height:h,pixels,parameters:preset,algorithm:VERSION,edgePixels};
  }
  const api=Object.freeze({generate,resolveParameters,PRESETS,RANGES,VERSION});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.LineArtEngine=api;
})(typeof globalThis==='undefined'?this:globalThis);
