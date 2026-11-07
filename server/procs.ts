// One server process per core (KR_PROCS, HOSTING.md "One process per core"): which match process owns a lobby code,
// and the messages between the front (server/front.ts) and its match processes (server/index.ts with KR_PROC set).
// With KR_PROCS unset or 1 the server is the single process it always was and nothing here routes anything.
import os from "node:os";

/** the characters of a lobby code (server/index.ts newCode, event codes in server/admin/events.ts) */
export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** a lobby code as a player or a URL gives it: upper case, letters and digits, at most 8 */
export const lobbyCode = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
/** match processes: KR_PROCS, "auto" for one per core; 1 (the default) is one process that is also the front. At most
 *  one per code character, so every process owns some codes */
export const PROCS = Math.max(1, Math.min(CODE_CHARS.length, process.env.KR_PROCS === "auto" ? os.availableParallelism() : Math.floor(Number(process.env.KR_PROCS) || 1)));
/** this match process's index under a front (0..PROCS-1); -1 for a single process, and for the front itself */
export const PROC = process.env.KR_PROC === undefined ? -1 : Number(process.env.KR_PROC);
/** the match process that owns a lobby code: its first character's place in CODE_CHARS, modulo the process count. A
 *  process only mints codes it owns, so the front routes a code without asking anyone */
export const procOf = (code: string, n = PROCS) => Math.max(0, CODE_CHARS.indexOf(code[0] ?? "")) % n;

/** what a match process tells the front about itself every PUSH_MS: its share of /health, and its event lobbies (the
 *  admin's cap counts them across processes) */
export interface ProcHealth {
  lobbies: number; clients: number; sockets: number; events: number;
  /** rooms players have made here since it started: the front matches them against the rooms it sent here */
  made: number;
  /** rooms each address owns here (outside event mode's admin lobbies), for the per-address room cap across processes */
  owners: Record<string, number>;
  transports: Record<string, unknown>; inputs: unknown[]; performance?: unknown;
}
export const PUSH_MS = 500;
/** front → match process. "conn": a game WebSocket's TCP socket rides along as the handle, with the upgrade request it
 *  already read (base64) and the address the front counted it under. "owners": the rooms each address owns on the other
 *  processes, as they last reported. "call": an admin request, answered by "reply" */
export type ToProc =
  | { t: "conn"; ip: string; raw: string }
  | { t: "owners"; n: Record<string, number> }
  | { t: "call"; id: number; fn: "snapshot" | "action" | "info"; arg?: unknown };
/** match process → front. "gone": a socket the front handed over has closed (the front's per-address count drops) */
export type ToFront =
  | { t: "health"; h: ProcHealth }
  | { t: "gone"; ip: string }
  | { t: "dirty" }
  | { t: "reply"; id: number; v: unknown };
