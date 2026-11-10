/* Public boundary: confirmed ImageData -> transparent black-line ImageData. */
(() => {
  class LineArtProcessor {
    constructor(workerURL='line-art-worker.js'){this.workerURL=workerURL;this.pending=null;this.nextId=0;}
    cancel(){
      if(!this.pending)return;
      this.pending.worker.terminate();
      this.pending.reject(new DOMException('已被新的照片或参数替换','AbortError'));
      this.pending=null;
    }
    generate(image,options={}){
      this.cancel();
      const id=++this.nextId;
      return new Promise((resolve,reject)=>{
        let worker;
        try{worker=new Worker(this.workerURL);}catch(error){reject(error);return;}
        this.pending={worker,reject,id};
        const finish=(error,result)=>{
          if(this.pending?.id!==id)return;
          worker.terminate();this.pending=null;
          if(error)reject(error);else resolve({...result,layer:new ImageData(result.pixels,result.width,result.height)});
        };
        worker.onmessage=({data})=>{if(data.id===id)finish(data.error?Error(data.error):null,data.result);};
        worker.onerror=event=>{event.preventDefault();finish(Error('无法运行线稿处理，请通过本机静态服务器打开页面。'));};
        worker.onmessageerror=()=>finish(Error('线稿处理数据无法读取'));
        // Always copy. Transferring the confirmed source would detach future inputs.
        try{
          const pixels=new Uint8ClampedArray(image.data);
          worker.postMessage({id,image:{width:image.width,height:image.height,data:pixels},options},[pixels.buffer]);
        }catch(error){finish(error);}
      });
    }
    dispose(){this.cancel();}
  }
  window.LineArtProcessor=LineArtProcessor;
})();
