// CPU-only authoritative host + fan-out benchmark; runs unchanged on Linux. Writes a kong-perf-result (schema.ts).
// Target any checkout: npm run bench:host -- --root <other checkout> --out reports/performance/host-base.json
// One scenario only: --scenario combat. Compare runs with tools/performance/compare.mts.
// The four scenarios are synthetic and run in the match's WARM-UP phase (m.warmupS = 1e9): they isolate host/fan-out
// cost, they are not real-play coverage.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { arg, env, save, source, stats } from './common.mts';
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type RunResult } from './schema.ts';
const root=path.resolve(arg('--root','.')), ticks=+arg('--ticks','1800'), warm=240, seed=707, out=arg('--out','reports/performance/host.json');
const all=['clustered','dispersed','combat','bots'], only=arg('--scenario','').split(',').filter(Boolean);
for(const s of only)if(!all.includes(s))throw Error(`unknown --scenario ${s}; one of ${all.join(', ')}`);
const mod=(p:string)=>import(pathToFileURL(path.join(root,p)).href);
const [{Terrain},{decodeTerrainFile},{buildStaticWorld},{Match},{MatchHost,writeSnapshotFor,SnapshotBatch},{Writer},{makeInput,PS,SK,B},{SNAP_EVERY},{POIS,WEAPONS}] = await Promise.all([
  mod('shared/world/terrain.ts'),mod('shared/world/terrain-gen.ts'),mod('shared/sim/static-world.ts'),mod('shared/sim/match.ts'),mod('shared/net/host.ts'),mod('shared/net/proto.ts'),mod('shared/sim/player.ts'),mod('shared/sim/const.ts'),mod('shared/world/map.ts')
]);
const startedAt=new Date().toISOString(), run0=performance.now(), environment=env();
const b=fs.readFileSync(path.join(root,'public/assets/terrain/island.bin'));
const td=decodeTerrainFile(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
const boot=performance.now(), {world,hash}=await buildStaticWorld(new Terrain(td.heights,td.biome),td), buildMs=performance.now()-boot;
const cases:CaseResult[]=[];
const ms=(summary:ReturnType<typeof stats>)=>({status:'ok' as const,unit:'ms' as const,better:'lower' as const,summary});
for(const scenario of only.length?only:all){
  const humans=scenario==='bots'?[]:Array.from({length:50},(_,id)=>({id,name:'P'+id,team:Math.floor(id/3)}));
  const m=new Match({seed,mode:'trios',world,humans}), host=new MatchHost(m), h=createHash('sha256');
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
  const used=process.cpuUsage(usage), wallMs=performance.now()-start;
  const c:CaseResult={
    scenario:{id:'host/'+scenario,version:1,seed,workload:'synthetic-warmup'},
    windows:{matchPhase:'warmup',benchWarmupTicks:warm,measuredTicks:ticks,cpuAndWallInclude:'bench warm-up ticks'},
    load:{seats:m.players.length,peers:host.peers.length,humansDriven:humans.length,pellets},
    metrics:{
      hostTickMs:ms(stats(costs)),snapshotTickMs:ms(stats(snaps)),simulationMs:ms(stats(sim)),
      bytesPerPlayerSecond:{status:'ok',unit:'bytes/s',better:'lower',value:bytes/(ticks/60)/m.players.length},
      cpuMs:{status:'ok',unit:'ms',better:'lower',value:(used.user+used.system)/1000},
    },
    gates:[{id:'hostP99Within60Hz',pass:stats(costs).p99<=1000/60,detail:`host p99 ${stats(costs).p99.toFixed(2)} ms, budget ${(1000/60).toFixed(2)} ms`}],
    detail:{bytes,packets,checksum:h.digest('hex'),checksumCovers:'every packet sent in the measured window (hashed inside the timed tick)',wallMs,memory0,memory1:process.memoryUsage()},
  };
  if(scenario==='combat')c.gates.push({id:'combatSustainedFire',pass:pellets>=ticks,detail:`${pellets} pellets in ${ticks} ticks`});
  // Isolate serialization from sim/transport; checksum covers the real tick stream above.
  const w=new Writer(new ArrayBuffer(16384)), serial:number[]=[];
  for(let k=0;k<180;k++){const t=performance.now();for(let pid=0;pid<m.players.length;pid++)writeSnapshotFor(w,m,pid);serial.push(performance.now()-t);}
  c.metrics.legacySnapshotFanoutMs=ms(stats(serial.slice(30)));
  if(SnapshotBatch){const batch=new SnapshotBatch(),cached:number[]=[];for(let k=0;k<180;k++){const t=performance.now();batch.begin(m);for(let pid=0;pid<m.players.length;pid++)writeSnapshotFor(w,m,pid,batch);cached.push(performance.now()-t);}c.metrics.cachedSnapshotFanoutMs=ms(stats(cached.slice(30)));}
  else c.metrics.cachedSnapshotFanoutMs={status:'unsupported',unit:'ms',reason:'this checkout has no SnapshotBatch'};
  cases.push(c);
  const tick=stats(costs);console.log(`${c.scenario.id}: host tick p50/p95/p99/max ${[tick.p50,tick.p95,tick.p99,tick.max].map(v=>v.toFixed(2)).join(' / ')} ms, ${c.load.seats} seats, ${pellets} pellets`);
}
const result:RunResult={schema:RESULT_SCHEMA,version:RESULT_VERSION,tool:'bench:host',startedAt,durationMs:performance.now()-run0,source:source(root),environment,
  config:{ticks,benchWarmupTicks:warm,scenarios:(only.length?only:all).join(','),worldHash:hash,mode:'trios'},cases,errors:[],artifacts:[]};
(result as any).detail={buildMs};
save(out,result);
console.log('wrote',out);
for(const c of cases)for(const g of c.gates)if(!g.pass){console.error(`FAIL: ${c.scenario.id} ${g.id}: ${g.detail}`);process.exitCode=1;}
