// Real WebSocket load; launch a PRIVATE test server, then pass --url http://127.0.0.1:5795.
// No public-server traffic unless the operator explicitly points this command there.
import { WebSocket } from 'ws';
import { Writer, M, writeInput, Reader, readSnapHeader, type SnapHeader } from '../../shared/net/proto';
import { makeInput, B } from '../../shared/sim/player';
import { arg,env,save,stats } from './common.mts';
const base=arg('--url','http://127.0.0.1:5795'),count=+arg('--players','50'),seconds=+arg('--seconds','25'),aux=process.argv.includes('--aux');
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n)),peers:any[]=[],errors:string[]=[],rtt:number[]=[],gaps:number[]=[],ack:number[]=[];
let bytes=0,packets=0,active=false,disconnects=0;
const wait=async(f:()=>boolean,label:string)=>{const end=performance.now()+60000;while(!f()){if(performance.now()>end)throw Error('timeout '+label);await sleep(10);}};
try{
  for(let i=0;i<count;i++){
    const p:any={ws:new WebSocket(base.replace(/^http/,'ws')+'/ws'),uid:0,token:'',code:'',pid:-1,seq:0,last:0,lastTick:-1,w:new Writer(new ArrayBuffer(64)),input:makeInput(),sent:new Float64Array(4096),snaps:0};peers.push(p);
    const onMessage=(data:any,binary:boolean)=>{
      if(!binary){const j=JSON.parse(String(data));if(j.t==='welcome'){p.uid=j.uid;p.token=j.aux;}if(j.t==='lobby')p.code=j.code;if(j.t==='match')p.pid=j.pids[p.uid];if(j.t==='error')errors.push(j.msg);return;}
      if(!active)return;bytes+=data.length;packets++;const r=new Reader(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));const kind=r.u8(),now=performance.now();
      if(kind===M.Pong){rtt.push(now-r.f64());return;}
      if(kind===M.Snapshot){const h={} as SnapHeader;readSnapHeader(r,h);if(h.tick<=p.lastTick)return;p.lastTick=h.tick;p.snaps++;if(p.last)gaps.push(now-p.last);p.last=now;const at=p.sent[h.lastSeq%4096];if(at&&h.lastSeq>p.seq-4096)ack.push(now-at);}
    };
    p.ws.on('message',onMessage);p.ws.on('error',(e:Error)=>errors.push(e.message));p.ws.on('close',()=>{if(active)disconnects++;});
    await wait(()=>!!p.uid,'welcome');p.ws.send(JSON.stringify({t:'hello',name:'BENCH '+i}));
    if(aux){p.aux=new WebSocket(base.replace(/^http/,'ws')+'/ws?attach=1');p.aux.on('open',()=>p.aux.send(JSON.stringify({t:'aux',token:p.token})));p.aux.on('message',onMessage);p.aux.on('error',(e:Error)=>errors.push(e.message));p.aux.on('close',()=>{if(active)disconnects++;});await wait(()=>p.aux.readyState===WebSocket.OPEN,'aux');}
    p.ws.send(JSON.stringify(i===0?{t:'create',mode:'trios'}:{t:'join',code:peers[0].code}));await wait(()=>!!p.code,'join');
  }
  peers[0].ws.send('{"t":"start"}');await wait(()=>peers.every(p=>p.pid>=0),'50 seats');await sleep(1500);
  active=true;const start=performance.now();let lastPing=0,lastStep=-1,assetRequest:Promise<any>|null=null;
  const httpResults:any[]=[];
  while(performance.now()-start<seconds*1000){
    const now=performance.now(),tick=Math.floor((now-start)*60/1000);
    if(tick!==lastStep){lastStep=tick;for(const p of peers){p.input.seq=++p.seq;p.input.mx=Math.sin((tick+p.pid)*.05)*.5;p.input.mz=.8;p.input.yaw=tick*.015+p.pid;p.input.buttons=tick%120<40?B.FIRE:tick%90<20?B.JUMP:0;p.sent[p.seq%4096]=now;writeInput(p.w.reset(),p.input);const data=Buffer.from(p.w.view());p.ws.send(data);p.aux?.send(data);}}
    if(now-lastPing>=250){lastPing=now;for(const p of peers){p.w.reset().u8(M.Ping).f64(performance.now());p.ws.send(Buffer.from(p.w.view()));}}
    // Asset-serving contention is part of a real match: a player joins while others are already fighting.
    if(process.argv.includes('--assets')&&!assetRequest&&now-start>4000){assetRequest=(async()=>{const html=await(await fetch(base)).text(),urls=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(m=>m[1]);for(const url of urls.slice(0,12)){const t=performance.now();const r=await fetch(base+url,{headers:{'accept-encoding':'br'}});await r.arrayBuffer();httpResults.push({url,ms:performance.now()-t,status:r.status,encoding:r.headers.get('content-encoding')});}})();}
    await sleep(2);
  }
  const elapsed=performance.now()-start;active=false;await assetRequest;
  const health=await(await fetch(base+'/health')).json();
  const result={environment:env(),players:count,sockets:count*(aux?2:1),durationMs:elapsed,transport:'real WebSocket; loopback when URL is local; no WAN inference',rttMs:stats(rtt),snapshotGapMs:stats(gaps),inputToAcknowledgmentMs:stats(ack),bytes,packets,bytesPerPlayerSecond:bytes/(elapsed/1000)/count,minSnapshots:Math.min(...peers.map(p=>p.snaps)),disconnects,errors,httpResults,health};
  save(arg('--out','reports/performance/sockets.json'),result);console.log(JSON.stringify(result,null,2));
  const budget=1000/60;
  if(errors.length||disconnects||result.minSnapshots<seconds*28||(health as any).performance?.tickMs?.p99>budget)process.exitCode=1;
}finally{active=false;for(const p of peers){p.ws.close();p.aux?.close();}}
