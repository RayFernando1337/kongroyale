// CPU-only authoritative host + fan-out benchmark; runs unchanged on Linux.
// Target any checkout: npm run bench:host -- --root <other checkout> --out reports/performance/host-base.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { arg, env, save, stats } from './common.mts';
const root=path.resolve(arg('--root','.')), ticks=+arg('--ticks','1800'), warm=240;
const mod=(p:string)=>import(pathToFileURL(path.join(root,p)).href);
const [{Terrain},{decodeTerrainFile},{buildStaticWorld},{Match},{MatchHost,writeSnapshotFor,SnapshotBatch},{Writer},{makeInput,PS,SK,B},{SNAP_EVERY},{POIS,WEAPONS}] = await Promise.all([
  mod('shared/world/terrain.ts'),mod('shared/world/terrain-gen.ts'),mod('shared/sim/static-world.ts'),mod('shared/sim/match.ts'),mod('shared/net/host.ts'),mod('shared/net/proto.ts'),mod('shared/sim/player.ts'),mod('shared/sim/const.ts'),mod('shared/world/map.ts')
]);
const b=fs.readFileSync(path.join(root,'public/assets/terrain/island.bin'));
const td=decodeTerrainFile(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
const boot=performance.now(), {world,hash}=await buildStaticWorld(new Terrain(td.heights,td.biome),td);
const result:any={environment:env(), worldHash:hash, buildMs:performance.now()-boot, seed:707, ticks, warmupTicks:warm, cases:[]};
for(const scenario of ['clustered','dispersed','combat','bots']){
  const humans=scenario==='bots'?[]:Array.from({length:50},(_,id)=>({id,name:'P'+id,team:Math.floor(id/3)}));
  const m=new Match({seed:707,mode:'trios',world,humans}), host=new MatchHost(m), h=createHash('sha256');
  m.warmupS=1e9;
  if(scenario==='dispersed')for(const p of m.players){p.x=-480+(p.id%10)*100;p.z=-360+Math.floor(p.id/10)*160;p.y=world.ground(p.x,p.z)+2;}
  const islet=POIS.find((p:any)=>p.id==='lobby-islet');
  if(scenario==='combat')for(const p of m.players){const a=p.id/50*Math.PI*2;p.x=islet.x+Math.sin(a)*18;p.z=islet.z+Math.cos(a)*18;p.y=world.ground(p.x,p.z)+.1;p.st=PS.Ground;p.hp=1e6;p.shield=0;p.active=0;Object.assign(p.slots[0],{kind:SK.Weapon,id:WEAPONS.indexOf(p.id%5===0?'shotgun':'ar'),rarity:0,count:1,mag:999});p.ammo.fill(999);}
  const input=makeInput(), costs:number[]=[], snaps:number[]=[], sim:number[]=[];
  let bytes=0,packets=0,measure=false,pellets=0;
  m.shotProbe=()=>{if(measure)pellets++;};
  host.peers.push(...m.players.map((p:any)=>({pid:p.id,invSeq:0,send(u:Uint8Array){if(measure){bytes+=u.length;packets++;h.update(u);}},sendResult(){}})));
  const step=m.step.bind(m);m.step=()=>{const t=performance.now();step();if(measure)sim.push(performance.now()-t);};
  const usage=process.cpuUsage(), start=performance.now(), memory0=process.memoryUsage();
  for(let tick=0;tick<warm+ticks;tick++){
    measure=tick>=warm;
    for(const p of m.players)if(!p.bot&&scenario!=='combat'){input.seq=tick+1;input.mx=Math.sin((tick+p.id*17)*.01)*.7;input.mz=.6;input.yaw=(p.id*1.7+tick*.005);input.pitch=0;input.buttons=tick%90<30?1:0;input.slot=0;m.pushInput(p.id,input);}
    if(scenario==='combat')for(const p of m.players){const target=m.players[(p.id+25)%50];p.hp=1e6;p.slots[0].mag=999;p.reloadT=0;input.seq=tick+1;input.mx=Math.sin(tick*.02+p.id)*.3;input.mz=0;input.yaw=Math.atan2(target.x-p.x,target.z-p.z);input.pitch=0;input.buttons=B.FIRE;input.slot=0;m.pushInput(p.id,input);}
    const t=performance.now();host.tick();const dt=performance.now()-t;
    if(measure){costs.push(dt);if(m.tick%SNAP_EVERY===0)snaps.push(dt);}
  }
  const used=process.cpuUsage(usage);
  result.cases.push({scenario,seats:m.players.length,peers:host.peers.length,pellets,hostMs:stats(costs),snapshotTickMs:stats(snaps),simulationMs:stats(sim),bytes,packets,bytesPerPlayerSecond:bytes/(ticks/60)/m.players.length,checksum:h.digest('hex'),wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,memory0,memory1:process.memoryUsage()});
  // Isolate serialization from sim/transport; checksum covers the real tick stream above.
  const w=new Writer(new ArrayBuffer(16384)), serial:number[]=[];
  for(let k=0;k<180;k++){const t=performance.now();for(let pid=0;pid<m.players.length;pid++)writeSnapshotFor(w,m,pid);serial.push(performance.now()-t);}
  result.cases.at(-1).legacySnapshotFanoutMs=stats(serial.slice(30));
  if(SnapshotBatch){const batch=new SnapshotBatch(),cached:number[]=[];for(let k=0;k<180;k++){const t=performance.now();batch.begin(m);for(let pid=0;pid<m.players.length;pid++)writeSnapshotFor(w,m,pid,batch);cached.push(performance.now()-t);}result.cases.at(-1).cachedSnapshotFanoutMs=stats(cached.slice(30));}
  console.log(scenario,JSON.stringify(result.cases.at(-1)));
}
save(arg('--out','reports/performance/host.json'),result);
if(result.cases.some((c:any)=>c.hostMs.p99>1000/60)){console.error('FAIL: host p99 exceeds 60 Hz tick budget');process.exitCode=1;}
if(result.cases.find((c:any)=>c.scenario==='combat').pellets<ticks){console.error('FAIL: combat workload did not sustain firing');process.exitCode=1;}
