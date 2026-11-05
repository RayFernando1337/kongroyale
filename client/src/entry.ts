// The module index.html loads. It decides, before any world code is fetched, whether this device can run the game at
// all: a phone or tablet with no mouse gets the desktop-only screen (desktop-only.ts) and the heavy boot (main.ts: the
// engine, the world, the workers, the WebGL context) is never imported, so the tab cannot run out of memory on it.
import { flag } from "./flags";
import { isTouchOnly, showDesktopOnly } from "./desktop-only";

const forced = flag("mobile");
if (forced === "1" || (forced !== "0" && isTouchOnly())) showDesktopOnly();
else void import("./main");
