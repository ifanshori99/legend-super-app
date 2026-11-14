# 858 E2E merah di milestone/m1 (engineer Codex)

Cabang fix/e2e-m1-858 dari milestone/m1. Langkah 0: `git log --all --oneline --grep=<id>`; sudah ada: catat, lewati.
Detail kartu: `.beads/issues.jsonl`.

- legend-y4f3l: e2e mock POS koreksi merah (legend-mzg, legend-rx0h, legend-sgg; 6 test).
- legend-0y8tf: e2e expo/pickup: mock memuat 'Sesi akses dukungan · Hanya baca' sehingga 'Panggil nomor' tidak bisa diklik.
- legend-42v4v: legend-e8oa.mock.spec.ts:254,263 (delivery) gagal.

Cari akar masalah dulu (mock basi vs bug produk). Bug produk nyata: jangan tambal test, lapor ke CTO. Jangan longgarkan asersi.
Browser: satu spec per run, selalu lewat `heavy` (antre FIFO, satu browser se-Mac).
Pra-gate AGENTS.md. Commit + push tanpa force. Lapor sha, spec yang hijau, akar masalah tiap kartu.
