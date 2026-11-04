export const url = "http://example.com/a//b";
export const re = /a\/\/b/;
export const tpl = `// not a comment ${url} /* nor this */`;
// @ts-expect-error the next line is wrong on purpose
export const n: number = "x";
export const m = import(/* @vite-ignore */ "./ok");
/// <reference types="node" />
