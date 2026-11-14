# token-radar-01 entry

A radar of pre-token protocols: `main.ts` reads the sealed DefiLlama snapshot and writes `board.json`, a static dashboard, three screenshots and the dossier the judge reads.

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json

MIT licensed (see LICENSE).
