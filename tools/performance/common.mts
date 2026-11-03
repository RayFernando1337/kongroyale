// Shared helpers for the Node benchmark runners: statistics, environment, source identity, JSON output and flags.
// Node-only; browser collectors share tools/performance/schema.ts instead.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Summary } from './schema.ts';
export function stats(values: number[]): Summary {
  const a = [...values].sort((a,b)=>a-b), n = a.length;
  const at = (p: number) => n ? a[Math.min(n-1, Math.ceil(p*n)-1)] : 0;
  return { n, mean: n ? a.reduce((s,v)=>s+v,0)/n : 0, p50:at(.5), p95:at(.95), p99:at(.99), max:n?a[n-1]:0 };
}
export const env = () => ({ at:new Date().toISOString(), platform:process.platform, arch:process.arch, release:os.release(), node:process.version, cpu:os.cpus()[0]?.model ?? 'unknown', cpus:os.cpus().length, memoryMB:Math.round(os.totalmem()/2**20), loadAvg1:os.loadavg()[0], gpu:null });
/** The measured checkout's commit and whether it has uncommitted changes; nulls when git can't tell. */
export function source(root: string) {
  const git = (...a: string[]) => { try { return execFileSync('git',['-C',root,...a],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { return null; } };
  const commit = git('rev-parse','HEAD'), status = git('status','--porcelain','--untracked-files=no');
  return { root, commit, dirty: status === null ? null : status.length > 0 };
}
export function save(file: string, data: unknown) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n'); }
export const arg = (name: string, fallback: string) => { const i=process.argv.indexOf(name); return i<0?fallback:process.argv[i+1]; };
