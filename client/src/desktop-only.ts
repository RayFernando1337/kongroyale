// The screen phones and tablets get instead of the game: Kong Royale has no touch controls and needs several times the
// memory a phone browser allows, so the boot (entry.ts) never starts there. Plain DOM in the loading screen's Toon style
// (the tokens and artwork are the ones index.html's #kr-loading uses); no module of the game is imported.

import { pageSearch } from "./flags";

/** A device with no mouse or trackpad: its primary pointer is coarse, or it says it is an iPhone, iPad or Android device. A
 *  laptop with a touchscreen and a mouse reports a fine pointer through any-pointer, so it boots normally. */
export function isTouchOnly(): boolean {
  if (typeof matchMedia !== "function" || matchMedia("(any-pointer: fine)").matches) return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; a real Mac has no touch points
  const hinted = /iPhone|iPad|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return hinted || matchMedia("(pointer: coarse)").matches;
}

const BASE: string = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

const CSS = `
#kr-desktop-only { --bg: #071422; --outline: #04101A; --text: #FFF8E7; --muted: #A9C6DA;
  --display: "Lilita One", "Arial Black", sans-serif; --ui: "Nunito", "Segoe UI", sans-serif;
  position: fixed; inset: 0; z-index: 200; overflow: auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 18px; padding: 24px; box-sizing: border-box; text-align: center; color: var(--text); font-family: var(--ui);
  background: linear-gradient(180deg, rgba(7,20,34,.55), rgba(7,20,34,.92)), var(--bg) url('${BASE}assets/ui/loading.webp') center / cover no-repeat; }
#kr-desktop-only * { box-sizing: border-box; }
#kr-desktop-only img { width: min(280px, 70vw); height: auto; -webkit-user-drag: none;
  filter: drop-shadow(3px 0 0 var(--outline)) drop-shadow(-3px 0 0 var(--outline)) drop-shadow(0 3px 0 var(--outline)) drop-shadow(0 -3px 0 var(--outline)) drop-shadow(0 6px 0 var(--outline)); }
#kr-desktop-only .eyebrow { margin: 0; font-weight: 900; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
#kr-desktop-only h1 { margin: 0; max-width: 14ch; font-family: var(--display); font-weight: 400; font-size: clamp(40px, 11vw, 84px); line-height: .98;
  letter-spacing: .01em; text-transform: uppercase; -webkit-text-stroke: 6px var(--outline); paint-order: stroke fill; text-shadow: 0 6px 0 var(--outline); }
#kr-desktop-only p.body { margin: 0; max-width: 34ch; font-weight: 700; font-size: clamp(16px, 4.2vw, 20px); line-height: 1.45; color: var(--text); }
#kr-desktop-only button { appearance: none; min-height: 56px; padding: 0 28px; border-radius: 16px; border: 4px solid var(--outline); box-shadow: 0 6px 0 var(--outline);
  background: linear-gradient(180deg, #FFE45C, #FFD21A 55%, #F2B800); color: var(--outline); cursor: pointer; font: inherit; font-weight: 900; font-size: 16px;
  letter-spacing: .14em; text-transform: uppercase; touch-action: manipulation; }
#kr-desktop-only button:active { transform: translateY(5px); box-shadow: 0 1px 0 var(--outline); }
#kr-desktop-only button:focus-visible { outline: 4px solid #fff; outline-offset: 3px; }
#kr-desktop-only .fine { margin: 0; font-weight: 700; font-size: 13px; color: var(--muted); }
`;

async function copyLink(url: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(url); return true; } catch { /* no clipboard access: the fallback below */ }
  const field = document.createElement("textarea");
  field.value = url;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, url.length);
  try { return document.execCommand("copy"); } catch { return false; } finally { field.remove(); }
}

/** Replaces the loading screen with the desktop-only screen. Loads nothing else. */
export function showDesktopOnly(): void {
  (window as unknown as { __krLoadingStop?: () => void }).__krLoadingStop?.();
  document.getElementById("kr-loading")?.remove();
  document.getElementById("c")?.remove();
  (window as unknown as { __kr: unknown }).__kr = { ready: false, desktopOnly: true, errors: [] };
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = document.createElement("main");
  root.id = "kr-desktop-only";
  root.innerHTML = `<img src="${BASE}assets/ui/toon/kong-royale-lockup.svg" alt="Kong Royale" width="320" height="119" draggable="false" />
<p class="eyebrow">Battle royale · 50 players</p>
<h1>Desktop only, for now</h1>
<p class="body">Kong Royale needs a mouse and keyboard and doesn't run on phones or tablets yet. Open this link on a computer to play.</p>
<button type="button">Copy link</button>
<p class="fine" role="status" aria-live="polite"></p>`;
  const button = root.querySelector("button")!, status = root.querySelector<HTMLElement>(".fine")!;
  const params = new URLSearchParams(pageSearch);
  params.delete("mobile");
  const query = params.toString();
  const link = location.origin + location.pathname + (query ? "?" + query : "") + location.hash;
  button.addEventListener("click", () => {
    void copyLink(link).then((ok) => {
      button.textContent = ok ? "Copied" : "Copy link";
      status.textContent = ok ? "Link copied. Paste it on your computer." : link;
    });
  });
  document.head.appendChild(style);
  document.body.appendChild(root);
}
