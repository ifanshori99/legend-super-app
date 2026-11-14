# Brief: engineer — perbaikan temuan reservasi + kontak tamu dari profil pelanggan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/reservation-reschedule` (e73f0649e). Cabang akhir: `ws/reservation-followups` (menggantikan ws/reservation-reschedule di batch63).

## Tujuan (keputusan CTO sudah diambil)
1. Temuan Codex P2 `apps/api/src/services/reservation-reschedule.ts:192`: guard DP memakai waktu sebelum menunggu lock. Ambil waktu keputusan SETELAH lock didapat (dan di dalam transaksi), supaya approve yang mengantre melewati batas penalti ditolak 409 `RESERVATION_RESCHEDULE_LATE`. Catatan: founder sedang memutuskan W3 (tolak reschedule terlambat vs penalti ikut jadwal asli); jangan ubah aturannya, hanya waktunya.
2. Temuan Codex P2 `apps/api/src/services/reservation-guest-notify.ts:350`: retry mencabut token A dan membuat B; bila email A terkirim tapi respons hilang, provider mendeduplikasi dengan kunci lama tanpa mengirim B, link tamu mati. Perbaikan: retry tidak mencabut token sebelumnya; token lama tetap valid sampai kedaluwarsa normal atau sampai pengiriman berikutnya terkonfirmasi; hanya hash yang disimpan, tidak pernah token mentah.
3. `legend-q4sv2`: isi `reservations.customer_profile_id` saat booking: cari profil pelanggan tenant dari nomor WA/telepon (atau email bila itu satu-satunya kontak), buat bila belum ada, sesuai pola profil pelanggan yang sudah ada. Jangan menyimpan kontak tamu baru langsung di tabel reservations. Data pribadi: tingkat K, isolasi tenant wajib, jangan log kontak.

## Kartu
Buat kartu bd untuk temuan 1 dan 2 (discovered-from legend-9txo / legend-lb3c), plus `legend-q4sv2`. Aturan kartu di `~/.agents/team/brief-template.md`.

## Scope
Service dan route reservasi, profil pelanggan (hanya fungsi cari/buat), test terkait. Jangan sentuh loyalty/referral. Migrasi bila perlu: `0575-0576` saja, lalu `node ~/.agents/team/check-journal.mjs origin/milestone/m1`.

## Pembagian paralel
Explore (2): alur approve + lock; alur booking + profil pelanggan. test-writer: gagal-dulu untuk 1, 2, 3. implementer: satu per tujuan (file terpisah). Heavy: satu test-runner. Review: satu `architect` effort high (data pribadi).

## Bukti, sebelum melapor
Test terarah reservasi hijau lewat `heavy`, pra-gate AGENTS.md. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
