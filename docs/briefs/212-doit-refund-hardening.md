# Brief: engineer — pengerasan refund DOIT dari temuan Codex 134 (legend-2ol8g, legend-3usn8, legend-kl46s)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/doit-refund-hardening` dari ujung `milestone/m1` terbaru, worktree `.worktrees/doit-refund-hardening`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tingkat K (uang). Tiga temuan Codex atas refund DOIT yang sudah ada di m1:
1. `legend-2ol8g` (P1) `apps/api/src/services/payment-doit-refund-webhook.ts:133`: webhook refund Rp4.000 dengan `amount:"3999.0"` membuang nominal tidak sah saat normalisasi tetapi tetap cocok lewat `refund_id`, lalu processor menyelesaikan Rp4.000 tanpa cek nominal. `payment_id:null` juga dibuang sehingga cek payment terlewat. Wajibkan nominal sah yang sama dengan refund dan payment id sah sebelum menyimpan atau memproses webhook. Tidak cocok: parkir + audit, jangan selesaikan.
2. `legend-3usn8` (P1) `apps/api/src/services/payment-refund.service.ts:1873`: worker bisa tertahan sesudah cek lease bernilai true. Sesudah lease + margin 10 menit, finance menyelesaikan refund manual, lalu worker yang jalan lagi tetap POST dan pelanggan dibayar dua kali. Cek lease terpisah bukan fencing. Serialkan dispatch dan settle manual: transisi status bersyarat (atau token fencing) yang diambil sebelum POST dan juga diambil settle manual, sehingga hanya satu yang menang.
3. `legend-kl46s` (P2) `apps/api/src/services/payment-webhook.service.ts:727`: fallback konflik settle manual hanya mencari payment utama intent. Dana dari payment `p2` (intent memakai `p1`) berakhir `REFUND_UNMATCHED` tanpa audit konflik. Cocokkan lewat bukti sumber dana dengan kandidat unik.
Detail: `bd show <id>` untuk tiap kartu, brief lama `docs/briefs/134-second-opinion-doit-reset.md` di folder utama.

## Kartu
Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: tiga file di atas, helper parsing webhook DOIT, test. Jangan: skema/migrasi (bila fencing butuh kolom baru: berhenti dan lapor, CTO memberi nomor), `qr-order-consumers.ts` dan `qr-order-pricing.ts` (cabang lain), guard jurnal, payroll, pos, edge, auth, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu di basis untuk tiap temuan: (1) webhook nominal salah atau payment null tidak menyelesaikan refund dan tercatat; (2) worker yang tertahan lalu jalan lagi sesudah settle manual tidak POST (dan sebaliknya settle manual ditolak bila dispatch sudah memegang hak kirim); (3) dana dari p2 cocok dan konflik teraudit. Test refund DOIT lama tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/212b-second-opinion-doit-refund-hardening.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil per kartu, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
