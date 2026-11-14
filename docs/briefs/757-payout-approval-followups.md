# Brief: engineer — tindak lanjut payout sebelum batch 64c (UANG)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `ui/payout-wiring` (f47c6536c, sudah memuat ws/payout-evidence-hardening). Langkah pertama: `git merge --no-ff origin/ws/payout-followups` (6574cb40f; saudara di atas evidence-hardening) dan selesaikan konflik bila ada. Cabang akhir: `ws/payout-approval-followups`.

## Kartu (urut prioritas)
1. `legend-3j9yz` (P1, temuan second opinion Codex): `apps/web/src/features/ws10-payroll-payout/components/approval-tab.tsx:127` menampilkan config rekening sumber dari cache 30 detik. Bila sumber diganti A->B saat draft lalu batch diajukan, penyetuju melihat A tetapi backend membekukan B (`payroll-payout.service.ts:1205`). Keputusan CTO: request persetujuan membawa sumber yang dilihat penyetuju; backend menolak bila beda dengan sumber beku batch (409, kode baru); UI menampilkan sumber beku dari DTO batch, bukan config terkini. Test regresi draft->pending dengan cache A dan config B.
2. `legend-dz8g3` (P1): unggah bukti payout hanya menerima step-up MFA. Keputusan CTO: pakai kebijakan step-up yang sama dengan route resolve (MFA atau password). Jangan longgarkan di luar itu.
3. `legend-eszso` (P2): tampilkan nama pengusul langkah-1 ke penyetuju kedua (tenant sama saja), bukan "Orang lain".
4. `legend-ctuia` (P2): tombol batalkan batch untuk batch lama tanpa snapshot rekening. Cek dulu apakah endpoint batal ada. Bila ada: tombol dengan izin, step-up, dan alasan. Bila TIDAK ada: jangan bangun endpoint baru; laporkan ke CTO.
5. `legend-oggiw` (P3, bila waktu cukup): tab kosong saat dialog ditutup, label badge, teks input file Inggris, galat catatan tidak hilang saat mengetik.

Di awal: `bd update <id> --status in_progress` per kartu yang dikerjakan (lewati `ghostex board associate` bila error multi-board). Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: `apps/web/src/features/ws10-payroll-payout/**`, service/route/validator payout di apps/api dan packages/shared, test terkait, katalog teks.
- Jangan: trigger PAYOUT-18 dan migrasi 0600/0608 (bila kartu 1 butuh kolom baru: berhenti dan tanya CTO; kemungkinan tidak perlu karena sumber sudah dibekukan di batch).

## Pembagian paralel (giliran pertama)
- Explore (2): (a) alur approve batch dan sumber beku di service + DTO; (b) route step-up resolve vs unggah, dan dari mana nama pengguna bisa diambil per tenant.
- test-writer: test gagal-dulu kartu 1 (409 mismatch, sukses bila sama, tidak ada perubahan state saat ditolak) dan kartu 2 (password step-up diterima di unggah; tanpa step-up ditolak).
- implementer: (a) API kartu 1+2+3, (b) web kartu 1+3+4+5. File tidak bertumpuk.
- Pemegang token heavy: satu subagent.
- Review: satu subagent `architect` effort xhigh (uang) pada diff akhir.

## Bukti selesai
- Test terarah API lewat `LEGEND_TEST_FILES=... heavy pnpm test`; e2e mock `e2e/payout.mock.spec.ts` sekali di akhir lewat `heavy`.
- Pra-gate AGENTS.md: prettier, eslint, text-contract, typecheck api dan web sekali lewat `heavy`.
- Screenshot 390 dan 1280 panel persetujuan (sumber beku + nama pengusul).

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Satu watcher per job; jangan antre typecheck ganda. Aturan uang yang ragu: pilih yang membatasi pembayaran dan tanya CTO.

## Sebelum melapor
Commit hanya file scope, rename cabang ke `ws/payout-approval-followups`, push tanpa force. Jangan merge ke milestone.

## Laporan
Hasil per kartu, bukti, file berubah, commit, cabang akhir, test gagal-dulu, temuan architect, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
