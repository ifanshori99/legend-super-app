# 1187 Isolasi test untuk 2 worker vitest + sisa e2e (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (satu implementer per kartu, berkas terpisah; reviewer di akhir).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `milestone/m1` (2b23b324f). Cabang kerja: `ws/1187-test-isolasi`. Tingkat S, hanya file test/e2e. Tanpa migrasi.

Tujuan: membuka jalan ke 2 worker vitest (full run sekarang 2j43m). Daftar tabrakan: `docs/qa/1170-two-worker-collisions.md` (ada di cabang `origin/ws/1170-flake-higiene`; baca dengan `git show origin/ws/1170-flake-higiene:docs/qa/1170-two-worker-collisions.md`).

## Kartu (`bd show <id>`)
1. `legend-vn40t`: kuota plan di `hris-leave-release-event-db` bertabrakan antar worker. Data test dibuat unik per file/tenant, bukan global.
2. `legend-xh240`: `payroll-policy-api` pagination + isolasi tenant bocor antar worker. Asersi dibatasi ke tenant/fixture milik test.
3. `legend-df7qv`: test yang memulihkan mapping kas lewat `replace(mappings)` gagal diam-diam di bawah aturan 1147 (contoh: teardown so-f3 di `payroll-payout-870-gl-pending`, sudah dibetulkan di batch96). Cari pola serupa, ganti dengan restore yang lolos aturan.
4. Sisa e2e `e2e/legend-cz9g.mock.spec.ts` baris ~144-155, 241-249, 298-304, 328-338: tambah `waitForHydration`/timeout 30s seperti bagian lain spec itu (base sesudah 1170 belum di m1: ambil versi `origin/ws/1170-flake-higiene` hanya bila perlu; bila tidak, catat dan lewati).

## Batas
Jangan ubah kode produk (`apps/api/src/services`, `apps/web/src/routes`). Jangan sentuh `payroll-payout-recon*`, test `payroll-payout-*lock*`, `reservation-*`, `payment-webhook*` (cabang lain). `legend-tx787` bukan bagian brief ini.

## Bukti selesai
Per kartu: reproduksi tabrakan dua worker secara terarah (`LEGEND_TEST_FILES="<file A> <file B>" heavy pnpm test` dengan `VITEST_MAX_WORKERS=2` bila jalur ringan mengizinkan) sebelum dan sesudah. Tidak ada run penuh. Prettier + eslint file berubah. Commit dan push. Tutup kartu sesudah bukti. Tunggu job heavy dengan Bash run_in_background satu notifikasi, jangan monitor heartbeat.

## Laporan
SHA, kartu ditutup, jumlah subagent dan puncak, hasil gate, yang belum teruji. Lapor sekali.
