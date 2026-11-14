# 791 Temuan architect atas ghostex/157120a3 (10a196bc1), 14 Nov

Putusan: boleh jadi satu langkah merge, tetapi mm029 dan po3fe belum boleh ditutup; gerbang rilis alarm tetap tertutup. Tidak ada kebocoran antar-tenant; aagpf dan ewmfd beres.

P0 (inti kartu legend-ofq4f):

1. `X-Device-Token` wajib di `apps/api/src/routes/emergency.routes.ts:59`, tetapi tidak ada kode web yang mengirimnya; `startEmergencySessionCall` (`apps/web/src/features/ws01-device-pin/api.ts:67`) selalu DEVICE_NOT_REGISTERED; socket penerima hanya menerima cookie darurat (`middleware/receiver-session.ts`, `edge/panic-relay-realtime.ts`). Buat penyedia device token di browser.
2. Pendaftaran subscription push ditolak semua (`apps/api/src/routes/notification.routes.ts:83`), tabel selalu kosong. Sambungkan pendaftaran + public key VAPID.

P1: 3. `apps/api/src/worker/notification-adapters.ts:1305-1308` hanya mengirim ke satu subscription (paling lama). Kirim ke semua subscription petugas (batas mis. 5), urut `lastSuccessAt`/`createdAt` terbaru. 4. `notification-adapters.ts:1659`: tanpa konfigurasi push, `panic_alert.raised` berhenti sehingga notifikasi in-app ikut hilang dan event ke dead-letter. Tetap buat notifikasi in-app, lalu log error operator (atau worker menolak start bila push tidak dikonfigurasi di produksi).

P2: 5. `notification-adapters.ts:1310`: satu subscription gagal dibuka menggagalkan semua. Tangkap per subscription, lewati, lanjut. 6. `apps/web/src/lib/areas/definitions.ts:100`: pintu area ops tidak memuat `facility.emergency.respond`; peran khusus yang hanya punya izin itu tersaring dari /fasilitas. Tambahkan. 7. `switch-user-screen.tsx:71`: setelah PIN kembali ke /fasilitas tanpa `facilityId`. Teruskan search params asal.
