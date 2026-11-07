// Words the public dashboard never shows. publish.mts scans the built page for ALWAYS_FORBIDDEN plus data.hide, and
// built.mts checks the text it takes from repo files against the same list before it renders, so the page that is
// refused at publish time is refused at build time, with the sentence that caused it.
export const ALWAYS_FORBIDDEN = "advisory|advisories|ghsa|security|lobby cap|role switch";
