// One voice connection (WebRTC, audio only): a squadmate, or a caster seat listening in. The game server relays the
// handshake (server/voice.ts) — offers, answers and ICE candidates ride the game socket as { t: "rtc", to, d }. Each
// connection has a random id; every signal carries it, so a stale answer / candidate of a torn-down attempt is ignored.
//
// Playback: the remote stream plays through a (hidden) <audio> element — Chrome only feeds a remote WebRTC stream into
// WebAudio while a media element consumes it — and an AnalyserNode on the same stream measures its level (speaking
// lights). The element's volume is the listener's volume for that peer.
//
// ICE: on a LAN / localhost the host candidates connect directly; on any other host a public STUN server
// is added so players behind home routers find each other (no TURN: a strict NAT pair stays silent, the rest of the
// game is unaffected). ?ice=stun:host:port overrides in dev builds only (in production a crafted link could send a
// player's browser to someone else's server and reveal their address).
import { flag } from "../flags";


export interface VoiceSignal { kind: "offer" | "answer" | "ice"; id: string; sdp?: string; cand?: RTCIceCandidateInit | null }

function iceServers(): RTCIceServer[] {
  try {
    const q = import.meta.env.DEV ? flag("ice") : null;
    if (q) return q.split(",").filter(Boolean).map((urls) => ({ urls }));
    const h = location.hostname;
    const local = h === "localhost" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || h.endsWith(".local");
    return local ? [] : [{ urls: "stun:stun.l.google.com:19302" }];
  } catch { return []; }
}

const rid = () => Math.random().toString(36).slice(2, 10);

export interface PeerOpts {
  /** "p3" (a player) or "s0" (a caster seat) */
  target: string;
  send: (to: string, d: VoiceSignal) => void;
  /** our microphone track (null = we only listen) */
  track: MediaStreamTrack | null;
  /** sendrecv (mates who both talk), sendonly (to a caster seat / a mate without a mic), recvonly (we have no mic) */
  dir: RTCRtpTransceiverDirection;
  ctx: AudioContext | null;
  volume: number;
}

export class VoicePeer {
  readonly pc: RTCPeerConnection;
  id = rid();
  readonly target: string;
  /** the remote side's audio (null until its track arrives) */
  stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null; private src: MediaStreamAudioSourceNode | null = null;
  private readonly buf = new Float32Array(512);
  private pendingIce: RTCIceCandidateInit[] = [];
  private closed = false;
  /** we sent the offer (the remote side answers) */
  offerer = false;
  /** a key describing who could talk when it was made — a change (someone got a mic) rebuilds the connection */
  key = "";
  private vol: number;
  constructor(private readonly o: PeerOpts) {
    this.target = o.target; this.vol = o.volume;
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc.onicecandidate = (e) => { if (!this.closed) o.send(o.target, { kind: "ice", id: this.id, cand: e.candidate ? e.candidate.toJSON() : null }); };
    this.pc.ontrack = (e) => this.play(e.streams[0] ?? new MediaStream([e.track]));
    this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === "failed") this.onFailed?.(); };
  }
  onFailed: (() => void) | null = null;

  /** offerer: one audio transceiver, our track on it (if any) */
  async offer() {
    this.offerer = true;
    const t = this.pc.addTransceiver("audio", { direction: this.o.dir });
    if (this.o.track && (this.o.dir === "sendrecv" || this.o.dir === "sendonly")) await t.sender.replaceTrack(this.o.track);
    const off = await this.pc.createOffer();
    await this.pc.setLocalDescription(off);
    if (!this.closed) this.o.send(this.o.target, { kind: "offer", id: this.id, sdp: this.pc.localDescription?.sdp });
  }
  /** a signal for this connection (an offer makes us the answerer: the caller created us with the offer's id) */
  async signal(d: VoiceSignal) {
    if (this.closed) return;
    try {
      if (d.kind === "offer" && d.sdp) {
        this.id = d.id;
        await this.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
        const t = this.pc.getTransceivers()[0];
        if (t) {
          t.direction = this.o.dir;
          if (this.o.track && (this.o.dir === "sendrecv" || this.o.dir === "sendonly")) await t.sender.replaceTrack(this.o.track);
        }
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        this.o.send(this.o.target, { kind: "answer", id: this.id, sdp: this.pc.localDescription?.sdp });
        await this.flushIce();
      } else if (d.kind === "answer" && d.sdp && d.id === this.id && this.pc.signalingState === "have-local-offer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
        await this.flushIce();
      } else if (d.kind === "ice" && d.id === this.id && d.cand) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(d.cand); else this.pendingIce.push(d.cand);
      }
    } catch (e) { console.warn("voice: signal failed", (e as Error)?.message ?? e); }
  }
  private async flushIce() { const q = this.pendingIce; this.pendingIce = []; for (const c of q) { try { await this.pc.addIceCandidate(c); } catch { /* stale */ } } }

  private play(stream: MediaStream) {
    if (this.closed || this.stream === stream) return;
    this.stream = stream;
    const a = this.audio ??= document.createElement("audio");
    a.autoplay = true; a.srcObject = stream; a.volume = this.vol;
    void a.play().catch(() => { /* resumes on the next gesture (unlock) */ });
    if (this.o.ctx) {
      try {
        this.src?.disconnect();
        this.src = this.o.ctx.createMediaStreamSource(stream);
        this.analyser = this.o.ctx.createAnalyser(); this.analyser.fftSize = 512;
        this.src.connect(this.analyser);
      } catch { this.analyser = null; }
    }
  }
  /** a play() refused before a user gesture: try again (called on the first key / click) */
  resume() { if (this.audio && this.audio.paused) void this.audio.play().catch(() => {}); }
  setVolume(v: number) { this.vol = v; if (this.audio) this.audio.volume = Math.max(0, Math.min(1, v)); }
  /** RMS of the remote audio right now (0 … ~0.5) */
  level(): number {
    const an = this.analyser; if (!an) return 0;
    an.getFloatTimeDomainData(this.buf);
    let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return Math.sqrt(s / this.buf.length);
  }
  /** inbound audio bytes so far (tests: is audio really flowing) */
  async inboundBytes(): Promise<number> {
    let n = 0; const st = await this.pc.getStats();
    st.forEach((r) => { if (r.type === "inbound-rtp" && (r as { kind?: string }).kind === "audio") n += (r as { bytesReceived?: number }).bytesReceived ?? 0; });
    return n;
  }
  close() {
    if (this.closed) return; this.closed = true;
    try { this.pc.close(); } catch { /* gone */ }
    try { this.src?.disconnect(); } catch { /* gone */ }
    if (this.audio) { this.audio.srcObject = null; this.audio.remove(); }
  }
}

/** one AudioContext for every voice analyser on the page (made on first use) */
let ctx: AudioContext | null = null;
export function voiceCtx(): AudioContext | null {
  if (ctx) return ctx;
  try { ctx = new AudioContext(); } catch { ctx = null; }
  return ctx;
}
/** level above which a voice counts as speaking (RMS; the fake test tone and a normal voice both clear it) */
export const SPEAK_LEVEL = 0.012;
