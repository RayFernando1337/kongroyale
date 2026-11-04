import assert from "node:assert/strict";
import type * as Flags from "../../client/src/flags";

type Env = { search?: string };
let run = 0;

async function load(env: Env): Promise<typeof Flags> {
  const g = globalThis as Record<string, unknown>;
  delete g.location;
  if (env.search !== undefined) g.location = { search: env.search };
  return import(`../../client/src/flags.ts?run=${run++}`);
}

{
  const { flag } = await load({});
  assert.equal(flag("vegsplat"), true);
  assert.equal(flag("vegsyncscatter"), false);
  assert.equal(flag("vegpre"), false);
  assert.equal(flag("spldens"), 0.3);
  assert.equal(flag("view"), null);
  assert.deepEqual(flag("vegdbg"), []);
  assert.equal(flag("impgrade"), undefined);
}

{
  const { flag } = await load({ search: "?vegsplat=0&vegsyncscatter=0&spldens=0.5&vegdbg=noimp,,nolod0&vegpre=1&view=a&view=b&impgrade=1,2,x,4&vegsplatsmall=&impcull=false" });
  assert.equal(flag("vegsplat"), false);
  assert.equal(flag("vegsplatsmall"), true);
  assert.equal(flag("impcull"), true);
  assert.equal(flag("vegsyncscatter"), true);
  assert.equal(flag("spldens"), 0.5);
  assert.deepEqual(flag("vegdbg"), ["noimp", "nolod0"]);
  assert.equal(flag("vegpre"), true);
  assert.equal(flag("view"), "a");
  assert.deepEqual(flag("impgrade"), [1, 2, NaN, 4]);
}

console.log("flags: ok");
