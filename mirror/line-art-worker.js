'use strict';
importScripts('line-art-engine.js');
self.onmessage=({data:{id,image,options}})=>{
  try{
    const begin=performance.now(),result=LineArtEngine.generate(image,options);
    result.processingMs=performance.now()-begin;
    self.postMessage({id,result},[result.pixels.buffer]);
  }catch(error){self.postMessage({id,error:error.message||'线稿处理失败'});}
};
