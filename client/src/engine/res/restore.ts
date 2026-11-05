export type Phase = "source" | "bake";
type Hook = () => void | Promise<void>;
type ModuleRestore = { can(id: string): boolean; rebuild(ids: readonly string[]): Promise<void> };

const hooks: Record<Phase, Set<Hook>> = { source: new Set(), bake: new Set() };
const missing = new Map<string | null, number>();
let epoch = 0;
let owner: string | null = null;
let modules: ModuleRestore = { can: () => false, rebuild: async () => {} };

export const contextEpoch = () => epoch;

export function onRestore(phase: Phase, fn: Hook): () => void {
  hooks[phase].add(fn);
  return () => { hooks[phase].delete(fn); };
}

export function bake(fn: () => void): () => void {
  fn();
  return onRestore("bake", fn);
}

export async function asOwner<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = owner;
  owner = id;
  try { return await fn(); } finally { owner = prev; }
}

export function unrestorable(): () => void {
  const by = owner;
  missing.set(by, (missing.get(by) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    missing.set(by, (missing.get(by) ?? 1) - 1);
  };
}

export function restoreModulesWith(m: ModuleRestore) { modules = m; }

export function lostModules(): { rebuild: string[]; blocked: string[] } {
  const rebuild: string[] = [], blocked: string[] = [];
  for (const [id, n] of missing) {
    if (n <= 0) continue;
    if (id !== null && modules.can(id)) rebuild.push(id);
    else blocked.push(id ?? "(no module)");
  }
  return { rebuild, blocked };
}

export async function restoreAll(): Promise<void> {
  const { rebuild, blocked } = lostModules();
  if (blocked.length) throw new Error("no restore path for resources of " + blocked.join(", "));
  epoch++;
  for (const fn of [...hooks.source]) await fn();
  await modules.rebuild(rebuild);
  for (const fn of [...hooks.bake]) await fn();
}
