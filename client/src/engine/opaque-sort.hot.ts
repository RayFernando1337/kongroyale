// The opaque draw order (WebGLRenderer.setOpaqueSort, installed by engine.ts). three sorts opaque draws by group order,
// render order, then MATERIAL id, so two materials sharing one shader program are only adjacent when their ids happen
// to be: ~180 program switches per frame in a town for ~136 distinct programs, each switch re-uploading the camera,
// light and shadow uniforms (draw census, RAY-232). This order puts the program right after render order and keeps
// three's own keys behind it: group order, render order, program, material id, material variant, depth, object id.
// Only draws with the same group and render order and no other key between them move, and the last key (object id)
// still makes the order total and stable. A material not yet drawn has no program and sorts first (-1); from its first
// draw on it joins its program's run.
type Mat = { id: number; krSortFrame?: number; krProgram?: number };
type Item = { groupOrder: number; renderOrder: number; material: Mat; materialVariant: number; z: number; id: number };
type Props = { get(m: object): { currentProgram?: { id: number } | null } };

let frame = 0;
let props: Props | null = null;

/** the renderer whose material properties hold each material's current program */
export function useProperties(p: Props) { props = p; }
/** once per frame: program ids are re-read at most once per material per frame */
export function nextSortFrame() { frame++; }

function programOf(m: Mat): number {
  if (m.krSortFrame !== frame) {
    m.krSortFrame = frame;
    const p = props ? props.get(m).currentProgram : null;
    m.krProgram = p ? p.id : -1;
  }
  return m.krProgram!;
}

export function programFirstSort(a: Item, b: Item): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const ma = a.material, mb = b.material;
  if (ma !== mb) {
    const pa = programOf(ma), pb = programOf(mb);
    if (pa !== pb) return pa - pb;
    if (ma.id !== mb.id) return ma.id - mb.id;
  }
  if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}
