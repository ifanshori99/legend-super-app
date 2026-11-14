# Brief: designer (Codex) — halaman tamu kelola reservasi (legend-g12il)

## Peran
Baca `~/.agents/team/roles/designer.md`, lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b design/reservation-guest .worktrees/design-reservation-guest milestone/m1`.

## Tujuan
Mockup untuk gerbang founder: halaman tamu `/reservasi/kelola#<token>` yang dibuka dari link di pesan konfirmasi/pengingat reservasi. Backend ada di cabang `ws/reservation-reschedule` e73f0649e (endpoint permintaan reschedule tamu, aturan 409 `RESERVATION_RESCHEDULE_LATE` bila terlambat untuk refund DP penuh). Brief backend: `docs/briefs/676-reservation-reschedule.md`.

State wajib: detail reservasi (outlet, jam, jumlah tamu, DP), minta reschedule (pilih jam baru, menunggu persetujuan outlet), permintaan ditolak/disetujui, terlambat untuk reschedule (jelaskan DP/penalti dengan bahasa sederhana), batal reservasi, token kedaluwarsa/tidak valid, memuat, error. Mobile 390 utama, desktop 1280. Ikuti `~/.agents/team/ui-standard.md` dan gaya halaman tamu QR yang ada (`design/mockups/README-qr.md`).

1. Buat state lewat subagent Codex paralel (maks 6) di `design/mockups/reservation-guest/`.
2. Page review `design/mockups/reservation-guest/review.html`, cek `ghostex visual check <file> --out <png>` dan `--width 390` tanpa peringatan.

## Batas
Hanya `design/mockups/reservation-guest/`. Commit lalu push `design/reservation-guest` tanpa force.

## Laporan
Path page review, daftar state, tiga keputusan desain, asumsi untuk founder.
