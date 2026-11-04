// Sample library: manifest.json → decoded AudioBuffers, grouped into round-robin sets.
// Opus/Ogg is the primary codec; if the browser can't decode it (older Safari) every file falls back to AAC/M4A.

export interface ManifestFile {
  dur: number;
  ch: number;
  cat: string;
  /** P = max 100 ms K-weighted loudness ("I100") — layers that crossfade by distance are level-matched with it */
  lufs: { I: number; M: number; S: number; TP: number; P?: number };
  loop?: [number, number];
  /** "flac" = a transient-critical file shipped LOSSLESS (your own gun's shot: a lossy codec's pre-echo smeared
   * its pressure spike 3 ms early); fetched as <id>.flac whatever the library codec is */
  fmt?: "flac";
}
export interface Manifest {
  files: Record<string, ManifestFile>;
  norm?: Record<string, [string, number, number]>;
}

const groupOf = (id: string) => id.replace(/-\d\d$/, "");
/** a download that delivers no bytes for this long is aborted (a slow one that keeps delivering is not) */
const DOWNLOAD_STALL_MS = 15000;
/** a load (download, codec fallback, decode) that makes no progress for this long gives its slot back */
const LOAD_STALL_MS = 30000;
type Retry = { count: number; after: number };

export class Library {
  readonly buffers = new Map<string, AudioBuffer>();
  readonly groups = new Map<string, string[]>();
  manifest: Manifest = { files: {} };
  ext: "ogg" | "m4a";
  loaded = 0;
  total = 0;
  failed: string[] = [];
  private lastPick = new Map<string, string>();
  private lazy: ((group: string) => boolean) | null = null;
  private groupLoads = new Map<string, Promise<void>>();
  private idleSince = new Map<string, number>();
  /** lazy groups decoded / released so far (stats) */
  lazyLoaded = 0;
  lazyEvicted = 0;
  // ---- hardening: every load runs in a capped slot with stall timeouts; a failure cools down (1, 2, 4 … 30 s) before
  // the next request may retry it, instead of never (baseline) or in a storm
  /** loads / native decodes in flight at most. loadAll's 10 workers never reach it (the full library loads at full
   *  speed); on-demand groups get headroom beside them, and a burst of requests can't start hundreds at once */
  readonly concurrency = 16;
  private activeLoads = 0;
  private loadQueue: Array<{ start: () => void; cancel: () => void }> = [];
  private work = new AbortController();
  private activeCancels = new Set<() => void>();
  private retries = new Map<string, Retry>();
  private groupRetries = new Map<string, Retry>();
  get loading() { return { active: this.activeLoads, queued: this.loadQueue.length, pending: this.pending.size }; }
  private now() { return performance.now(); }
  private cooling(map: Map<string, Retry>, key: string) { return (map.get(key)?.after ?? 0) > this.now(); }
  private defer(map: Map<string, Retry>, key: string) {
    const count = (map.get(key)?.count ?? 0) + 1;
    map.set(key, { count, after: this.now() + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)) });
  }
  /** abort every download, detach stalled decodes and settle queued loads; later (explicit) loads start clean */
  cancelWork() {
    const old = this.work;
    old.abort();                     // (drain starts nothing while this.work is the aborted one)
    for (const job of this.loadQueue.splice(0)) job.cancel();
    for (const cancel of [...this.activeCancels]) cancel();
    this.wanted.length = 0; this.groupLoads.clear();
    this.work = new AbortController();
  }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); }
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { signal.removeEventListener("abort", cancel); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
      signal.addEventListener("abort", cancel, { once: true });
      promise.then((value) => { signal.removeEventListener("abort", cancel); if (signal.aborted) reject(signal.reason); else resolve(value); }, (error) => { signal.removeEventListener("abort", cancel); reject(error); });
    });
  }
  private pending = new Map<string, Promise<AudioBuffer | undefined>>();
  /** decode sample rate per file (null = the context's): long loops / beds at 32 kHz, dark distant layers at 24 kHz —
   * decoded PCM is what costs memory (252 MB in a match at full rate); a buffer at any rate plays in the 48 kHz context */
  rateFor: ((id: string) => number | null) | null = null;
  private decoders = new Map<number, BaseAudioContext>();
  private nativeDecodes = 0;
  private decodeWaiters: Array<() => void> = [];
  get decoding() { return { active: this.nativeDecodes, queued: this.decodeWaiters.length }; }
  /** one decodeAudioData in a capped slot. Only the native completion frees the slot: an aborted load detaches from its
   *  decode, it never piles more stalled decodes on top */
  private async runDecode(context: BaseAudioContext, data: ArrayBuffer, signal: AbortSignal): Promise<AudioBuffer> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { const i = this.decodeWaiters.indexOf(start); if (i >= 0) this.decodeWaiters.splice(i, 1); reject(signal.reason); };
      const start = () => { signal.removeEventListener("abort", cancel); this.nativeDecodes++; resolve(); };
      if (this.nativeDecodes < this.concurrency) start();
      else { this.decodeWaiters.push(start); signal.addEventListener("abort", cancel, { once: true }); }
    });
    const decoded = Promise.resolve().then(() => { signal.throwIfAborted(); return context.decodeAudioData(data); })
      .finally(() => { this.nativeDecodes--; this.decodeWaiters.shift()?.(); });
    return this.abortable(decoded, signal);
  }
  /** decoded PCM held right now, bytes (stats) */
  get pcmBytes() { let b = 0; for (const x of this.buffers.values()) b += x.length * x.numberOfChannels * 4; return b; }

  constructor(private ctx: BaseAudioContext, readonly base: string) {
    let opus = true;
    try {
      const a = typeof document !== "undefined" ? document.createElement("audio") : null;
      opus = !a || a.canPlayType('audio/ogg; codecs="opus"') !== "";
    } catch { /* keep opus */ }
    this.ext = opus ? "ogg" : "m4a";
  }

  async loadManifest(): Promise<Manifest> {
    const signal = this.work.signal;
    const data = await this.download(this.base + "manifest.json", "no-cache", signal);
    signal.throwIfAborted();
    this.manifest = JSON.parse(new TextDecoder().decode(data)) as Manifest;
    this.groups.clear(); this.pCache.clear();
    for (const id of Object.keys(this.manifest.files)) {
      const g = id.replace(/-\d\d$/, "");
      if (!this.groups.has(g)) this.groups.set(g, []);
      this.groups.get(g)!.push(id);
      if (g !== id) {
        if (!this.groups.has(id)) this.groups.set(id, [id]);
      }
    }
    this.total = Object.keys(this.manifest.files).length;
    return this.manifest;
  }

  /** load every file, highest priority first (lower number = sooner), `par` in flight at a time. Groups matching
   * `lazy` are skipped: they are decoded on demand (loadGroup) and released when idle (evict) — the long ambience beds
   * are ~2/3 of the decoded PCM and you only ever hear the few around you */
  async loadAll(priority: (id: string) => number = () => 1, par = 10, lazy?: (group: string) => boolean, prefetch?: (group: string) => boolean, only?: (id: string) => boolean): Promise<void> {
    this.lazy = lazy ?? null;
    // lazy groups are skipped unless `prefetch` says they are needed at the start (the drop's winds): those are loaded
    // like the rest and released later like any idle lazy group. `only`: just this subset now (the boot set)
    const ids = Object.keys(this.manifest.files).filter((id) => (!lazy || !lazy(groupOf(id)) || !!prefetch?.(groupOf(id))) && (!only || only(id)) && !this.buffers.has(id)).sort((a, b) => priority(a) - priority(b));
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        await this.load(id);
      }
    };
    await Promise.all(Array.from({ length: par }, worker));
  }

  /** one file, decoded (undefined if it failed — it may be retried after its cool-down; `explicitRetry` skips that) */
  load(id: string, explicitRetry = false): Promise<AudioBuffer | undefined> {
    const have = this.buffers.get(id);
    if (have) return Promise.resolve(have);
    if (explicitRetry) this.retries.delete(id);
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.work.signal.aborted || this.cooling(this.retries, id)) return Promise.resolve(undefined);
    const parent = this.work.signal;
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", abort, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (buffer: AudioBuffer | undefined) => void;
    const promise = new Promise<AudioBuffer | undefined>((r) => { resolve = r; });
    let done = false, started = false, cancelling = false;
    const finish = (buffer?: AudioBuffer) => {
      if (done) return; done = true;
      signal.removeEventListener("abort", cancel); parent.removeEventListener("abort", abort); clearTimeout(stall); this.activeCancels.delete(cancel);
      if (started) this.activeLoads--;
      if (this.pending.get(id) === promise) this.pending.delete(id);
      resolve(buffer); this.drain();
    };
    const cancel = () => {
      if (done || cancelling) return; cancelling = true;
      controller.abort();
      if (!parent.aborted) this.defer(this.retries, id);
      finish();
    };
    // progress (bytes arriving, the decode starting) re-arms the stall timer: slow-but-moving loads are never cut
    const alive = () => { clearTimeout(stall); if (!done) stall = setTimeout(cancel, LOAD_STALL_MS); };
    const job = { cancel, start: () => {
      if (done) return;
      started = true; this.activeLoads++; this.activeCancels.add(cancel);
      signal.addEventListener("abort", cancel, { once: true });
      alive();
      void this.fetchDecode(id, signal, alive).then(finish, () => finish());
    } };
    this.pending.set(id, promise); this.loadQueue.push(job); this.drain();
    return promise;
  }

  private drain() {
    while (!this.work.signal.aborted && this.activeLoads < this.concurrency && this.loadQueue.length) this.loadQueue.shift()!.start();
  }

  /** fetch one file; aborted when `parent` aborts or when no bytes arrive for DOWNLOAD_STALL_MS */
  private async download(url: string, cache?: RequestCache, parent = this.work.signal, alive: () => void = () => {}): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parent.reason);
    parent.addEventListener("abort", cancel, { once: true });
    if (parent.aborted) cancel();
    let stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
    const progress = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS); alive(); };
    try {
      const r = await this.abortable(fetch(url, { signal: controller.signal, cache }), controller.signal);
      if (!r.ok) throw new Error(`${r.status}`);
      progress();
      if (!r.body) return await this.abortable(r.arrayBuffer(), controller.signal);
      const reader = r.body.getReader(), parts: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await this.abortable(reader.read(), controller.signal);
        if (done) break;
        parts.push(value); n += value.byteLength; progress();
      }
      const out = new Uint8Array(n);
      for (let i = 0, o = 0; i < parts.length; o += parts[i].byteLength, i++) out.set(parts[i], o);
      return out.buffer;
    } finally { clearTimeout(stall); parent.removeEventListener("abort", cancel); }
  }

  private async fetchDecode(id: string, signal: AbortSignal, alive: () => void = () => {}): Promise<AudioBuffer | undefined> {
    if (this.manifest.files[id]?.fmt === "flac") {
      try {
        const data = await this.download(`${this.base}${id}.flac`, undefined, signal, alive);
        alive();
        const buf = await this.abortable(this.decode(id, data, signal), signal);
        signal.throwIfAborted();
        this.buffers.set(id, buf); this.loaded++; this.recovered(id);
        return buf;
      } catch { if (signal.aborted) return undefined; /* a browser without FLAC decoding: the lossy files below */ }
    }
    for (const ext of this.ext === "ogg" ? (["ogg", "m4a"] as const) : (["m4a"] as const)) {
      try {
        const data = await this.download(`${this.base}${id}.${ext}`, undefined, signal, alive);
        alive();
        const buf = await this.abortable(this.decode(id, data, signal), signal);
        signal.throwIfAborted();
        if (ext !== this.ext) this.ext = ext; // first failure flips the whole library to the fallback codec
        this.buffers.set(id, buf);
        this.loaded++; this.recovered(id);
        return buf;
      } catch {
        if (signal.aborted) return undefined;
        /* try the fallback */
      }
    }
    // cools down before a retry; the failure list (stats) keeps the newest 128
    this.defer(this.retries, id);
    if (!this.failed.includes(id)) { this.failed.push(id); if (this.failed.length > 128) this.failed.shift(); }
    return undefined;
  }

  private recovered(id: string) { this.retries.delete(id); const i = this.failed.indexOf(id); if (i >= 0) this.failed.splice(i, 1); }

  private async decode(id: string, data: ArrayBuffer, signal: AbortSignal): Promise<AudioBuffer> {
    const rate = this.rateFor?.(id) ?? null;
    if (rate && rate < this.ctx.sampleRate) {
      try {
        let d = this.decoders.get(rate);
        if (!d) {
          const O = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext });
          const C = O.OfflineAudioContext ?? O.webkitOfflineAudioContext;
          if (!C) throw new Error("no OfflineAudioContext");
          d = new C(1, 1, rate);
          this.decoders.set(rate, d);
        }
        // (decodeAudioData detaches the buffer: keep a copy for the fallback)
        return await this.runDecode(d, data.slice(0), signal);
      } catch { signal.throwIfAborted(); /* this browser can't decode at another rate: the context's rate */ }
    }
    return this.runDecode(this.ctx, data, signal);
  }

  /** ask for a lazy group WITHOUT starting its fetches here (hot paths: a frame's update / a trigger) — pump()
   * starts them from the engine's idle-time slice, a couple of groups per slice */
  request(group: string) {
    if (this.groupLoads.has(group)) { this.idleSince.delete(group); return; }
    if (this.work.signal.aborted || this.cooling(this.groupRetries, group)) return;
    if (!this.wanted.includes(group)) this.wanted.push(group);
  }
  private wanted: string[] = [];
  /** start the fetch + decode of up to `n` requested groups (idle time) */
  pump(n = 2) {
    while (n-- > 0 && this.wanted.length) void this.loadGroup(this.wanted.shift()!);
  }
  get requested() { return this.wanted.length; }

  /** decode every variant of a (lazy) group; resolves when done. A group with a missing variant cools down and is
   *  requested again later (the variants it has keep playing) */
  loadGroup(group: string, explicitRetry = false): Promise<void> {
    if (explicitRetry) { this.groupRetries.delete(group); for (const id of this.groups.get(group) ?? []) this.retries.delete(id); }
    if (this.work.signal.aborted || this.cooling(this.groupRetries, group)) return Promise.resolve();
    let p = this.groupLoads.get(group);
    if (!p) {
      const ids = this.groups.get(group) ?? [];
      const load: Promise<void> = Promise.all(ids.map((id) => this.load(id))).then((results) => {
        if (this.groupLoads.get(group) !== load) return;
        if (results.some((b) => !b)) { this.defer(this.groupRetries, group); this.groupLoads.delete(group); }
        else { this.lazyLoaded++; this.groupRetries.delete(group); }
      });
      p = load;
      this.groupLoads.set(group, p);
    }
    this.idleSince.delete(group);
    return p;
  }

  isLazy(group: string) { return !!this.lazy && this.lazy(group); }

  /** a lazy group stopped playing at time `t` (s) */
  markIdle(group: string, t: number) { if (this.isLazy(group)) this.idleSince.set(group, t); }
  markUsed(group: string) { this.idleSince.delete(group); }

  /** release lazy groups idle for more than `after` s (their PCM is garbage-collected) */
  evict(t: number, after = 45) {
    for (const [g, since] of this.idleSince) if (t - since >= after) this.release(g);
  }

  releaseLoaded(keep: (group: string) => boolean) {
    for (const [g, ids] of this.groups) {
      if (!this.isLazy(g) || keep(g) || ids.some((id) => this.pending.has(id)) || !ids.some((id) => this.buffers.has(id))) continue;
      this.release(g);
    }
  }

  private release(group: string) {
    this.idleSince.delete(group);
    for (const id of this.groups.get(group) ?? []) {
      if (this.buffers.delete(id)) this.loaded--;
      this.pending.delete(id);
    }
    this.groupLoads.delete(group);
    this.lazyEvicted++;
  }

  /** the (lowest) sample rate the group's decoded buffers hold — voices of buffers below the context rate take an
   * anti-image low-pass (mixer.aaIn) */
  rateOf(group: string): number {
    let r = this.ctx.sampleRate;
    for (const id of this.groups.get(group) ?? []) { const b = this.buffers.get(id); if (b && b.sampleRate < r) r = b.sampleRate; }
    return r;
  }

  has(group: string): boolean {
    const g = this.groups.get(group);
    return !!g && g.some((id) => this.buffers.has(id));
  }

  /** round-robin pick: random, never the same variant twice in a row (allocation-free: one reused result record) */
  pick(group: string, rnd: () => number): { id: string; buf: AudioBuffer; file: ManifestFile } | undefined {
    const g = this.groups.get(group);
    if (!g) return undefined;
    let n = 0;
    for (let i = 0; i < g.length; i++) if (this.buffers.has(g[i])) n++;
    if (!n) return undefined;
    const last = this.lastPick.get(group);
    let k = Math.floor(rnd() * n);
    let choice = "";
    for (let pass = 0; pass < 2 && !choice; pass++) {
      for (let i = 0, j = 0; i < g.length; i++) {
        if (!this.buffers.has(g[i])) continue;
        if (j++ === k) { choice = g[i]; break; }
      }
      if (n > 1 && choice === last) { choice = ""; k = (k + 1 + Math.floor(rnd() * (n - 1))) % n; }
    }
    if (!choice) return undefined;
    this.lastPick.set(group, choice);
    const r = this.pickOut;
    r.id = choice; r.buf = this.buffers.get(choice)!; r.file = this.manifest.files[choice];
    return r;
  }
  private pickOut = { id: "", buf: null as unknown as AudioBuffer, file: null as unknown as ManifestFile };

  /** a group's mean transient loudness as the engine plays it (P + normDb), dB — null when unmeasured / missing */
  groupP(group: string): number | null {
    const c = this.pCache.get(group);
    if (c !== undefined) return c;
    const g = this.groups.get(group);
    let sum = 0, n = 0;
    for (const id of g ?? []) {
      const f = this.manifest.files[id];
      if (f?.lufs?.P === undefined) continue;
      sum += f.lufs.P + this.normDb(f); n++;
    }
    const v = n ? sum / n : null;
    this.pCache.set(group, v);
    return v;
  }
  private pCache = new Map<string, number | null>();

  /** dB that level-matches a file to its category reference (the build measured every file) */
  normDb(file: ManifestFile): number {
    const n = this.manifest.norm?.[file.cat];
    if (!n) return 0;
    const [mode, target] = n;
    const measured = (file.lufs as unknown as Record<string, number>)[mode] ?? target;
    return Math.max(-12, Math.min(12, target - measured));
  }
}
