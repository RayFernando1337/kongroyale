// The title screen's PLAYTEST flag.
// On: the title shows ONE Play button (no Trios / Solo, no bot difficulty, no Friends popover) with room to breathe. Play
// still does exactly what it did (the same lobby action, the player's remembered mode + difficulty on this device).
// Title screen only — the match, the server and the admin lobby are untouched.
//   built bundle (what the playtest server serves) ........ ON
//   vite dev (npm run dev) ................................ OFF (dev keeps its bot matches)
//   ?playtest / ?playtest=1 ............................... ON  (any build)
//   ?dev / ?playtest=0 .................................... OFF (any build: bot matches with mode + difficulty)
//   VITE_KR_PLAYTEST=0|1 at build / dev-server start ....... the default above, overridden
import { flag } from "../flags";

const env = (import.meta as unknown as { env?: { DEV?: boolean; VITE_KR_PLAYTEST?: string } }).env ?? {};

export function playtestTitle(): boolean {
  const playtest = flag("playtest");
  if (flag("dev") !== null || playtest === "0") return false;
  if (playtest !== null) return true;
  if (env.VITE_KR_PLAYTEST === "1") return true;
  if (env.VITE_KR_PLAYTEST === "0") return false;
  return !env.DEV;
}
