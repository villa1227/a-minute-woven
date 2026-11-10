/* Browser-reported samples only. No interpolation, prediction or sensor mapping. */
(function(root){
  class PenInput {
    constructor({now=()=>performance.now(),onSample=()=>{},onEnd=()=>{},limit=50000}={}){
      Object.assign(this,{now,onSample,onEnd,limit});this.reset(0,0,null);
    }
    reset(width,height,sessionId){
      this.end('reset');Object.assign(this,{width,height,sessionId,samples:[],latest:null,active:null,stroke:0,full:false,mouseFallback:true,contactTimes:[]});
    }
    end(reason='interrupted'){
      if(this.active){this.active=null;this.onEnd(reason);}
    }
    process(event,rect){
      if(!this.width||this.full)return;
      const type=event.pointerType;
      if(!['pen','mouse'].includes(type)||event.isPrimary===false||type==='mouse'&&!this.mouseFallback)return;
      if(this.active&&this.active.id!==event.pointerId)return;
      if(event.type==='pointercancel'){this.end('cancelled');return;}
      if((event.buttons&~1)!==0||event.button===5||event.button===2){this.end('unsupported_button');return;}
      const down=event.type==='pointerdown'&&(event.buttons&1)!==0&&event.button===0;
      if(down&&!this.active)this.active={id:event.pointerId,stroke:++this.stroke};
      let events=event.type==='pointermove'&&event.getCoalescedEvents?event.getCoalescedEvents():[];
      if(!events.length)events=[event]; // Parent move is not appended to a coalesced batch.
      for(const point of events){
        if(this.full)break;
        const nx=(point.clientX-rect.left)/rect.width,ny=(point.clientY-rect.top)/rect.height;
        if(!Number.isFinite(nx)||!Number.isFinite(ny))continue;
        const contact=!!this.active&&(point.buttons&1)!==0&&event.type!=='pointerup';
        const received=this.now(),sample={strokeId:this.active?.stroke??null,eventType:event.type,pointerType:type,pointerId:event.pointerId,
          x:nx*this.width,y:ny*this.height,nx,ny,outside:nx<0||nx>1||ny<0||ny>1,contact,
          pressure:point.pressure,tiltX:point.tiltX,tiltY:point.tiltY,twist:point.twist,
          button:point.button,buttons:point.buttons,eventTimeMs:point.timeStamp,receivedTimeMs:received};
        this.latest=sample;
        // Hover is diagnostic only; store actual contact + the matching release.
        if(contact||this.active){
          this.samples.push(sample);
          if(contact)this.contactTimes.push(received);
          this.onSample(sample);
          if(this.samples.length>=this.limit){this.full=true;this.end('limit');}
        }
      }
      if(event.type==='pointerup'||!(event.buttons&1))this.end('released');
    }
    snapshot(){
      const now=this.now();this.contactTimes=this.contactTimes.filter(t=>now-t<1000);
      return {latest:this.latest,contact:!!this.active,rate:this.contactTimes.length,count:this.samples.length,full:this.full};
    }
    export(){return {schemaVersion:1,sessionId:this.sessionId,canvas:{width:this.width,height:this.height},
      clock:'eventTimeMs and receivedTimeMs are browser monotonic milliseconds since performance.timeOrigin',
      timeOrigin:typeof performance==='undefined'?null:performance.timeOrigin,limit:this.limit,full:this.full,samples:this.samples.slice()};}
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={PenInput};else root.PenInput=PenInput;
})(globalThis);
