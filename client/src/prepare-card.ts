export function prepareCard(kr: Record<string, unknown>) {
  const el = document.createElement("div");
  el.id = "kr-preparing";
  el.style.cssText = "position:fixed;inset:0;z-index:90;display:grid;place-items:center;background:radial-gradient(ellipse at center,rgba(8,26,40,.72),rgba(6,14,22,.9));font-family:'Barlow Condensed',Arial Narrow,sans-serif;color:#f6efc6;pointer-events:auto";
  el.innerHTML = `<div style="text-align:center;min-width:min(520px,80vw)"><div style="font-size:clamp(28px,4vw,48px);font-weight:800;letter-spacing:.08em;color:#ffd400">PREPARING THE ISLAND</div><div style="margin:18px 0 10px;height:12px;border-radius:6px;background:rgba(246,239,198,.16);overflow:hidden"><i style="display:block;height:100%;width:100%;transform-origin:left;transform:scaleX(0);background:linear-gradient(90deg,#ffb800,#ffe066);transition:transform .25s linear"></i></div><div data-t style="font-size:20px;font-weight:700;letter-spacing:.06em;opacity:.85"></div></div>`;
  document.body.appendChild(el);
  const bar = el.querySelector("i") as HTMLElement, txt = el.querySelector("[data-t]") as HTMLElement;
  const total = Math.max(1, (kr.streamTotal as number | undefined) ?? 1);
  const set = () => {
    const left = ((kr.streamPending as (() => string[]) | undefined)?.() ?? []).length + (kr.streamed ? 0 : 1);
    const k = kr.streamed ? (kr.warmDone === true ? 1 : 0.95) : Math.min(0.94, 1 - left / (total + 1));
    bar.style.transform = `scaleX(${k.toFixed(3)})`;
    const cur = String(kr.streamStage ?? "").replace(/^(build|integrate):(poi:)?/, "").replace(/-/g, " ").toUpperCase();
    txt.textContent = kr.streamed ? "WAKING THE KONGS" : cur ? `BUILDING ${cur}` : "";
  };
  set();
  return { set, remove: () => el.remove() };
}
