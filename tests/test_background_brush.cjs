const {test}=require('node:test'),assert=require('node:assert/strict');
const {adapt,BackgroundBrushRenderer,VERSION}=require('../mirror/background-renderer.js');
const {BASE}=require('../mirror/brush-mapping.js');
function mockCanvas(log){const ctx=new Proxy({}, {get:(o,k)=>o[k]||((...args)=>{log.push([k,...args]);if(k==='createRadialGradient')return {addColorStop:(...a)=>log.push(['stop',...a])};}),set:(o,k,v)=>{o[k]=v;return true;}});return {getContext:()=>ctx};}
test('percent-based broad size, eye limits, missing eyes and disabled mapping',()=>{
  const brush={...BASE,width:9.5,softness:4.5,textureStrength:3};
  const a=adapt(brush,{longestSide:1000,eyeActive:true});assert.equal(a.width,60);assert.equal(a.baseDiameter,60);
  assert.equal(adapt({...brush,width:28},{longestSide:1600,diameterPercent:16,eyeActive:true}).width,512);
  assert.equal(adapt({...brush,width:1.5},{longestSide:1000,eyeActive:true}).width,30);
  assert.equal(adapt({...brush,width:28},{longestSide:1000,eyeActive:false}).width,60);
  const off=adapt({...brush,color:[220,90,20],family:'grain',wobble:10},{longestSide:1000,mappingEnabled:false,eyeActive:true});
  assert.equal(off.width,60);assert.equal(off.wobble,0);assert.equal(off.family,'round');assert.deepEqual(off.color,BASE.color);
  assert.deepEqual(brush.color,BASE.color);assert.equal(a.renderer,VERSION);assert.ok(a.softness>brush.softness*.5);
  for(const settings of [{longestSide:0},{longestSide:100,diameterPercent:17}])assert.throws(()=>adapt(brush,settings));
});
test('distance-spaced broad marks cache identical tiles and are batch independent',()=>{
  const brush=adapt({...BASE,color:[180,80,50],family:'grain',textureStrength:3},{longestSide:1000});
  function run(points){const draw=[],tiles=[];const ctx={drawImage:(c,x,y)=>draw.push([x,y])};
    const r=new BackgroundBrushRenderer(ctx,'test',()=>mockCanvas(tiles));
    for(const [x,t] of points)r.draw({x,y:30,eventTimeMs:t,strokeId:1,contact:true,outside:false},brush);
    return {draw,r};
  }
  const a=run([[0,0],[120,120]]),b=run([[0,0],[30,30],[90,90],[120,120]]);
  assert.deepEqual(a.draw,b.draw);assert.equal(a.r.cacheBuilds,1);assert.ok(a.draw.length<30);
  a.r.draw({x:200,y:30,eventTimeMs:200,strokeId:1,contact:true,outside:true},brush);
  a.r.draw({x:300,y:30,eventTimeMs:300,strokeId:1,contact:true,outside:false},brush);
  assert.equal(a.draw.at(-1)[0],300-a.r.tile(brush).center,'outside re-entry starts with a dot');
});
test('cache is bounded and snapshots replay without original images or live state',()=>{
  const ctx={drawImage:()=>{}},r=new BackgroundBrushRenderer(ctx,'test',()=>mockCanvas([]));
  for(let i=0;i<35;i++)r.tile({...BASE,color:[i,50,70],width:50,textureStrength:2});
  assert.equal(r.cache.size,24);
  const brush=adapt(BASE,{longestSide:1000}),samples=[{x:0,y:0,eventTimeMs:0,strokeId:1,contact:true,outside:false}];
  const data={schemaVersion:2,renderer:VERSION,renderSeed:'test',samples,segments:[{kind:'sample',sampleIndex:0,brush},{kind:'break'}]};
  assert.equal(BackgroundBrushRenderer.replay(ctx,data,()=>mockCanvas([])).cacheBuilds,1);
  assert.throws(()=>BackgroundBrushRenderer.replay(ctx,{schemaVersion:2,renderer:'legacy'}));
});
