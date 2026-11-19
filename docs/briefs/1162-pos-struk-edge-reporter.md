# 1162 POS struk dan edge reporter (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1`. Cabang kerja: `ws/1162-pos-struk-edge`. Tingkat K (uang struk + sinkron offline): architect effort xhigh sebelum lapor.

## Kartu
1. `legend-gdjpu` SO 1111 P2: ACK void edge bisa mendahului ingest sukses. File: `apps/api/src/.../edge-receipt-run-reporter.ts:117`, `edge-order-redrive.job.ts:257`. Rincian: `docs/qa/second-opinion-pos-edge-1111.md`.
2. `legend-rh1hk` POS struk: laporan pull restore-detect membawa kursor outbox link. File: `pos-receipt.service.ts`, `pos-receipt.ts`. Satu area dengan gdjpu: kerjakan berurutan atau pembagian file tegas.
3. `legend-j772n` kontrak dokumen receipt/invoice perlu bucket DP. File: `packages/shared/src/pos/schemas.ts` (`checkDocumentTotals`), renderer struk. Catatan: int/batch95 menambah 8 baris di `schemas.ts`; jaga perubahan kecil dan aditif.
4. `legend-vet9d` rekap tutup hari perlu bucket DP (`pos-day.service.ts`). JANGAN mulai sebelum CTO mengabari batch95 sudah landing (int/batch95 mengubah file ini). Sesudah kabar: `git merge milestone/m1`, lalu kerjakan.

## Batas
- Jangan sentuh: `order-given.ts`, `payment-admin.service.ts` (thread 1095), `accounting-journal*` (kas), cabang edge `ghostex/eb4d9add`.
- Tanpa migrasi. Bila ternyata perlu migrasi: berhenti dan lapor ke CTO untuk nomor.
- Uang: test membuktikan total struk/rekap tidak menghitung DP dua kali dan tidak ada kas semu.

## Bukti selesai
Test gagal-dulu per kartu (terarah, `LEGEND_TEST_FILES=... heavy pnpm test`), typecheck api + shared + web lewat `heavy` sekali, prettier + eslint pada file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Bila vet9d masih menunggu batch95, lapor 3 kartu pertama dulu dan sebut vet9d menunggu.
