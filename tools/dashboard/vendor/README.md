# Vendored Mermaid

mermaid.min.js.gz is Mermaid 12.3.0 (`npm pack mermaid@12.3.0`, `dist/mermaid.min.js`, gzipped with `gzip -9 -n`), MIT licensed (mermaid.LICENSE).
The sha256 of the unzipped file is 336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3, and diagrams.mts refuses to run on anything else.
It is only used at build time: build.mts renders every diagram to inline SVG, so the published page carries no Mermaid script.
To update it, fetch the new version, gzip it, and change the version and hash here and in diagrams.mts together.
