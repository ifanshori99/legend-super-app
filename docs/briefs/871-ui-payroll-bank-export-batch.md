# Brief: ui-engineer — tombol berkas transfer bank di layar payroll run (legend-66xzn)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. UI mengikuti `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri dari `origin/fix/payout-second-opinion-870` (9f75ea558). Cabang baru: `fix/ui-payroll-bank-export-871`.

## Tujuan
API sekarang menolak `POST /api/hris/payroll/runs/:id/bank-transfer-files` dengan 409 `LEGACY_BANK_EXPORT_DISABLED` (pembayaran gaji hanya lewat batch payout yang disetujui). Layar payroll run tidak boleh lagi menawarkan tombol yang pasti gagal: arahkan aksi itu ke alur batch payout yang sudah ada (buat/lihat batch, setujui, ekspor dari batch), dan tetap tampilkan daftar serta unduhan arsip berkas lama. Bila 409 tetap datang (klien lama), tampilkan pesan bahasa biasa, bukan error mentah. Jangan merancang layar baru: pakai komponen dan alur payout yang sudah ada.

## Kartu
`legend-66xzn`. Di awal: `ghostex board associate legend-66xzn` dan `bd update legend-66xzn --status in_progress`. Saat melapor: `bd update legend-66xzn --status review` dan `bd comment legend-66xzn "<ringkasan>"`.

## Masukan
- `apps/web/src/features/ws10-payroll-run/api.ts:240` (`createBankFile`), `hooks.ts:226`, `mock.ts:689`.
- Alur batch payout: cari di `apps/web/src/features/` (payout) dan route terkait.
- Laporan: `docs/qa/second-opinion-payout.md` bagian P1 ekspor bank lama.

## Scope
- Boleh diubah: `apps/web/src/features/ws10-payroll-run/`, komponen/route layar payroll run, e2e terkait, katalog teks UI.
- Jangan disentuh: `apps/api`, migrasi, modul uang lain.

## Pembagian paralel (giliran pertama)
- Explore (2): pemakaian `createBankFile` dan alur batch payout di web.
- implementer (1-2): ganti aksi + pesan 409; hapus/ubah mock.
- ui-auditor dan reviewer berjalan bersamaan setelah implementasi.
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- Test web terkait (vitest/e2e terarah) lewat `heavy`; `heavy pnpm --filter @starter/web typecheck`.
- Pra-gate AGENTS.md (prettier, eslint, `node --test tests/text-contract.test.mjs` untuk teks baru).
- Screenshot layar sebelum/sesudah, lebar 390 dan desktop (`heavy ghostex visual check <page> --out <png>` atau Playwright).
- Commit dan push cabang tanpa force. Laporan: cabang, SHA, angka subagent. Jangan merge, jangan deploy.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor dengan log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
