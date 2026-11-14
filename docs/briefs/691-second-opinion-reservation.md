# Brief: second-opinion (Codex, high) — reschedule dan pesan tamu reservasi

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Jangan jalankan `bd`. Tidak mengubah file.

## Repo dan diff
`/Users/ifanshori99/Projects/legend super app/legend`. Rentang: `git diff milestone/m1...origin/ws/reservation-reschedule` (e73f0649e). Sudah direview architect Claude.

Berkas (hanya ini): `apps/api/src/services/reservation-reschedule.ts`, `reservation-guest-notify.ts`, `reservation-public.ts`, `reservation-consumers.ts`, `reservation-sweeps.ts`, `notification-delivery.ts`, `apps/api/src/routes/reservation-public.routes.ts`, `apps/api/src/worker-main.ts`, `apps/api/src/worker/notification-adapters.ts`. Subagent Codex maks 3: (1) reschedule + aturan DP, (2) pesan tamu + token, (3) route publik + sweep + worker.

## Invariant
- Outlet tidak rugi DP: reschedule tidak bisa dipakai untuk menghindari penalti batal-telat (approve ditolak 409 `RESERVATION_RESCHEDULE_LATE` bila batal sekarang tidak refund DP penuh, dihitung dari waktu asli).
- Hold meja dipindah atomik; tidak ada double booking saat konkuren; kapasitas dicek bila tamu bertambah.
- Token kelola tamu tidak tersimpan mentah (di body notifikasi, log, DB); token salah/kedaluwarsa ditolak; isolasi tenant/outlet.
- Pengingat H-24 idempoten (tidak terkirim ganda), konfirmasi hanya bila status masih confirmed.

## Laporan
Satu baris per temuan: `path:baris`, tingkat (P1/P2/P3), masalah, skenario gagal konkret, saran. Tanpa temuan: satu baris.
