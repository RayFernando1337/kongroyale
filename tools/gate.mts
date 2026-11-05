export type FlagKind = "bool" | "string" | "number" | "list";
type FlagValue<K extends FlagKind> = K extends "bool" ? boolean : K extends "number" ? number : K extends "list" ? string[] : string;
export type Flags<S extends Record<string, FlagKind>> = { [F in keyof S]?: FlagValue<S[F]> };

export class GateError extends Error {}

export function parseFlags<S extends Record<string, FlagKind>>(argv: string[], spec: S, opts: { positional?: boolean } = {}): { flags: Flags<S>; positional: string[] } {
  const flags: Record<string, unknown> = {}, positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (!opts.positional) throw new GateError(`unexpected argument "${arg}"`);
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq), inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const kind = spec[name];
    if (!kind) throw new GateError(`unknown flag ${name}; known: ${Object.keys(spec).join(", ")}`);
    if (name in flags) throw new GateError(`${name} given twice`);
    if (kind === "bool") {
      if (inline !== undefined) throw new GateError(`${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const values: string[] = inline !== undefined ? [inline] : [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--") && (kind === "list" || (inline === undefined && values.length === 0))) values.push(argv[++i]);
    if (values.length === 0 || values.some((v) => v === "")) throw new GateError(`${name} needs a value`);
    if (kind === "number") {
      const n = Number(values[0]);
      if (!Number.isFinite(n)) throw new GateError(`${name} must be a finite number, got "${values[0]}"`);
      flags[name] = n;
    } else flags[name] = kind === "list" ? values : values[0];
  }
  return { flags: flags as Flags<S>, positional };
}

export function nonEmpty<T>(items: T[], what: string): T[] {
  if (items.length === 0) throw new GateError(`found no ${what}, so there is nothing to check: refusing to pass`);
  return items;
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new GateError(`${what} must be one of ${allowed.join(", ")}, got "${value}"`);
  return value as T;
}

export function orExit<T>(tool: string, usage: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof GateError)) throw e;
    console.error(`${tool}: ${e.message}\nusage: ${usage}`);
    process.exit(2);
  }
}
