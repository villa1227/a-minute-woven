const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generate,resolveParameters,PRESETS,VERSION}=require('../mirror/line-art-engine.js');

function image(w,h,value=255){
  const data=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<w*h;i++){data[i*4]=data[i*4+1]=data[i*4+2]=value;data[i*4+3]=255;}
  return {width:w,height:h,data};
}
function rectangle(source,x,y,w,h,value=0){
  for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){
    const i=(yy*source.width+xx)*4;source.data[i]=source.data[i+1]=source.data[i+2]=value;
  }
}
function alphaCount(result){return result.pixels.reduce((n,x,i)=>n+(i%4===3&&x>0?1:0),0);}

test('flat and transparent images produce empty transparent line layers',()=>{
  for(const detail of ['minimal','simple','standard','rich']){
    const flat=image(90,70);assert.equal(generate(flat,{detail}).edgePixels,0);
    flat.data.fill(0);assert.equal(alphaCount(generate(flat,{detail})),0);
  }
});
test('extracts contours rather than filled silhouettes; deterministic, independent and black only',()=>{
  const source=image(160,120);rectangle(source,25,20,95,75);
  const original=new Uint8ClampedArray(source.data),result=generate(source);
  assert.ok(result.edgePixels>100);assert.ok(result.edgePixels<1000);
  assert.equal(result.pixels[(60*160+60)*4+3],0,'inside stays transparent');
  assert.equal(result.pixels[(5*160+5)*4+3],0,'background stays transparent');
  assert.equal(result.algorithm,VERSION);assert.equal(result.width,160);assert.equal(result.height,120);
  for(let i=0;i<result.pixels.length;i++)if(i%4!==3)assert.equal(result.pixels[i],0);
  generate(source,{detail:'rich',lineWidth:4});assert.deepEqual(generate(source),result);
  assert.deepEqual(source.data,original,'confirmed photo stays intact');
});
test('thickness expands the same contours and small disconnected specks are removed',()=>{
  const source=image(240,180);rectangle(source,45,40,100,100);rectangle(source,190,80,1,1);
  const thin=generate(source),thick=generate(source,{lineWidth:4});
  assert.equal(thin.edgePixels,thick.edgePixels);assert.ok(alphaCount(thick)>alphaCount(thin)*2);
  let isolated=0;for(let y=72;y<90;y++)for(let x=182;x<200;x++)isolated+=thin.pixels[(y*240+x)*4+3];
  assert.equal(isolated,0);
});
test('rich preset retains fine texture that simple preset smooths out',()=>{
  const source=image(220,140);rectangle(source,20,20,40,90,0);
  for(let y=25;y<105;y++)for(let x=100;x<180;x++){
    const i=(y*source.width+x)*4,value=145+50*Math.cos(x*Math.PI/2);
    source.data[i]=source.data[i+1]=source.data[i+2]=value;
  }
  const a=generate(source,{detail:'simple'}),b=generate(source,{detail:'rich'});
  assert.ok(b.edgePixels>a.edgePixels);
});
test('rejects unsafe dimensions, pixel arrays and unsupported parameters',()=>{
  for(const bad of [{width:1601,height:1,data:[]},{width:2,height:2,data:[]},{width:0,height:1,data:[]}])assert.throws(()=>generate(bad));
  for(const options of [{detail:'unknown'},{lineWidth:5},{lineWidth:.5}])assert.throws(()=>generate(image(4,4),options));
  assert.equal(generate(image(1,1)).edgePixels,0);
});

test('manual parameters affect extraction, remain isolated, and are returned for reproduction',()=>{
  const source=image(240,180);rectangle(source,45,40,100,100);rectangle(source,185,75,12,12);
  const normal=generate(source);
  const filtered=generate(source,{tuning:{minComponent:300}});
  assert.ok(filtered.edgePixels<normal.edgePixels);
  assert.equal(filtered.parameters.minComponent,300);
  const faint=image(160,120);rectangle(faint,25,20,95,75,180);
  assert.ok(generate(faint).edgePixels>0);
  assert.equal(generate(faint,{tuning:{minHigh:512}}).edgePixels,0);
  assert.deepEqual(generate(source),normal,'custom calls do not modify preset defaults');
  assert.equal(resolveParameters({detail:'minimal'}).sigma,2.5);
  assert.equal(resolveParameters({detail:'simple'}).sigma,1.7);
  assert.equal(PRESETS.standard.minComponent,15);
  const tune={sigma:2.2,percentile:.84,minHigh:50,minComponent:90,lowRatio:.6};
  const result=generate(source,{detail:'minimal',tuning:tune});
  for(const key of Object.keys(tune))assert.equal(result.parameters[key],tune[key]);
  for(const tuning of [{sigma:0},{sigma:NaN},{percentile:1},{minHigh:'30'},{minComponent:1.5},{lowRatio:.99},{unknown:1},[]])
    assert.throws(()=>generate(source,{tuning}));
});
