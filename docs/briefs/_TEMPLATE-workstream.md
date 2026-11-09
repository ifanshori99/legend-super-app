# Template brief agent (workstream, paralel dulu)

Agent menerima satu workstream besar (5–15 kartu atau satu cabang besar), bukan satu fix kecil. Tujuannya agar ada cukup potongan untuk dikerjakan subagent paralel: target puncak 10–15 subagent per agent. Batas agent 5–6 per Mac (RAM).

## Giliran pertama agent (wajib)
1. Baca berkas peran dan brief ini. Jangan baca kode sendiri: kirim 2–4 `Explore` sekaligus, satu per area.
2. Tulis `docs/briefs/sub-<topik>.md`: potongan, berkas milik tiap potongan (tidak bertumpuk), invarian, bukti selesai.
3. Dalam SATU pesan, spawn semua potongan sekaligus:
   - `implementer` per potongan berkas (maks 8; berkas bersentuhan: `isolation: worktree`).
   - `test-writer` dari spec/PRD, bersamaan dengan implementer, tidak menunggu kode.
4. Agent sendiri hanya menggabungkan, memutuskan, dan mengerjakan potongan sangat kecil.

## Pemeriksaan (satu giliran, paralel)
- Di antara langkah: `test-runner` (haiku) per file atau kelompok test yang terdampak, tanpa `heavy`. Bukan seluruh repo tiap kali.
- Legend: test terarah `LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test` dari root worktree (ringan, tanpa `heavy`); `pnpm test` penuh dan `pnpm check` hanya merge train, sekali, lewat `heavy`; jangan suite penuh paralel dari worktree yang sama.
- `reviewer` (Opus untuk K) dan `architect` (K) bersamaan.
- `ui-auditor` bila ada UI.
- Gate: thread tidak menjalankan `pnpm check` penuh. Cukup lint dan typecheck paket yang berubah lewat `heavy`, test terarah, dan `db:generate` harus kosong. Gate penuh dijalankan merge train. Dev server dan Playwright hanya bila agent butuh UI (maks 2 seluruh Mac).

## Laporan
SHA, kartu bd yang selesai (id), jumlah subagent yang di-spawn dan maksimum yang berjalan bersamaan, hasil gate, temuan review dan fixnya, yang belum teruji.
