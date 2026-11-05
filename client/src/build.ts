export type Channel = "stable" | "next" | "dev";

const env = (import.meta as unknown as { env?: { DEV?: boolean; VITE_KR_SHA?: string; VITE_KR_TAG?: string; VITE_KR_CHANNEL?: string } }).env ?? {};
const channel: Channel = env.DEV ? "dev" : env.VITE_KR_CHANNEL === "stable" || env.VITE_KR_CHANNEL === "next" ? env.VITE_KR_CHANNEL : "dev";
const sha = env.VITE_KR_SHA || "unknown";
const describe = env.VITE_KR_TAG || null;
const tag = describe?.replace(/-\d+-g[0-9a-f]+$/, "") ?? null;

export const BUILD = { channel, sha, tag, describe } as const;

export const buildLabel = (): string => [channel, channel === "dev" ? null : tag, sha].filter(Boolean).join(" · ");
