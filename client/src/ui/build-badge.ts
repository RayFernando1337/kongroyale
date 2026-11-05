import { BUILD, buildLabel } from "../build";

export function showBuildBadge(): void {
  const el = document.createElement("div");
  el.className = "kr-build-badge";
  el.dataset.channel = BUILD.channel;
  el.textContent = buildLabel();
  el.title = `${BUILD.describe ?? "no kong-v tag"} · ${BUILD.sha}`;
  el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:2px;z-index:99999;pointer-events:none;user-select:none;font:600 11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;color:#fbf3c9;background:rgba(10,30,46,0.55);border:1px solid " + (BUILD.channel === "next" ? "rgba(255,212,0,0.6)" : "rgba(255,95,87,0.6)") + ";border-radius:4px;padding:2px 6px;opacity:.75";
  document.body.appendChild(el);
}
