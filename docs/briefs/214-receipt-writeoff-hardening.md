# Brief: engineer — pengerasan write-off nomor struk dari Codex 201b (legend-l56xd, legend-xlvvl)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-writeoff-hardening` dari `ws/receipt-number-writeoff` a3649cdd (sudah di merge train batch27; merge train akan cherry-pick commit cabang ini). Worktree `.worktrees/receipt-writeoff-hardening`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tingkat K (nomor dokumen, auth). Temuan Codex 201b atas write-off (legend-0hzqw):
1. `legend-l56xd` (P1): owner-only bisa ditembus. `pos-receipt-writeoff.routes.ts:31` hanya memeriksa izin `pos.receipt.writeoff`. Lewat pengecualian otoritas puncak (`packages/shared/src/access/grants.ts:115`) admin tenant bisa membuat dan memberi custom role berisi izin itu, lalu penerimanya bisa write-off dengan MFA. Wajibkan penugasan peran template owner tenant yang aktif selain izin itu. Test: delegasi admin tenant lewat custom role ditolak 403; owner tetap bisa. Keputusan CTO: tambahkan juga syarat re-autentikasi baru (sesi atau verifikasi 2FA dalam beberapa menit terakhir) bila pola itu sudah ada di kode; bila belum ada, jangan bangun baru, catat sebagai kartu.
2. `legend-xlvvl` (P2):
   a. Rollback runbook (`docs/runbooks/receipt-number-writeoff.md:117`) hanya menghapus kode izin dari template owner. Custom role tetap menyimpannya, dan API versi lama menolak izin tak dikenal lewat parsing peran ketat (`packages/shared/src/access/schemas.ts:39`) sehingga daftar peran rusak. Hapus dari semua peran, tambah laporan preflight untuk tenant tanpa template owner, dan dokumentasikan jendela kompatibilitas saat migrasi jalan lebih dulu dari API.
   b. GET daftar write-off (`pos-receipt-writeoff.service.ts:199`) belum menolak di edge seperti POST; tambahkan penolakan yang sama.
   c. Helper lambat (`pos-receipt.service.ts:1530`) membaca struk lalu write-off di statement terpisah; struk terlambat di antaranya memberi celah palsu. Pakai satu snapshot statement atau gabungkan semua write-off di perhitungan set-based. Belum ada pemanggil produksi, tetapi tetap perbaiki.
   d. Dokumentasikan dan test bahwa merge run yang maju tetap mewajibkan semua struk nyata (`pos-receipt.service.ts:1416`). Perjelas runbook baris ~60: riwayat GET tetap menyimpan write-off, hanya daftar shift yang membuangnya.
Detail: `bd show legend-l56xd`, `bd show legend-xlvvl`.

## Kartu
Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: route dan service write-off, helper hitung celah di `pos-receipt.service.ts` (hanya bagian yang disebut), runbook, test. Jangan: migrasi baru, logika klaim/rotasi/alokasi urutan struk, sinkron edge (legend-jcby0, cabang lain nanti), refund, payroll, `worker-main.ts`, UI.

## Bukti selesai
Test reproduksi gagal dulu di basis untuk 1, 2b, 2c, lalu lulus. Test write-off lama tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/214b-second-opinion-receipt-writeoff-hardening.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil per kartu, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
