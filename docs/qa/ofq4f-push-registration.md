# legend-ofq4f: registrasi web push alarm panik

Cabang `ws/panic-push-registration` dari `origin/ghostex/157120a3` (10a196bc1), 14 Nov 2026. Brief dan desain: `docs/briefs/ofq4f-push-registration.md`. Temuan architect cabang basis: `docs/briefs/791-panic-architect-findings.md`.

## Yang berubah

- API memberi public key VAPID (`getPushKey`) hanya bila `NOTIFICATION_PUSH_PROVIDER=web_push` dan kebijakan tenant menyalakan web push.
- Registrasi push terikat ke user, tenant, sesi login, perangkat terdaftar (X-Device-Token) dan outlet. Tanpa perangkat, outlet hanya boleh dipilih oleh pemegang `facility.emergency.respond`. Sesi impersonasi (support) ditolak 403.
- X-Device-Token disimpan di browser lewat tombol "Pakai di perangkat ini" dan dikirim di tiap panggilan API. Server memverifikasi tanda tangan, tenant, dan status perangkat; token rusak dijawab `DEVICE_TOKEN_INVALID` dan browser menghapusnya.
- Pencabutan: keluar (sign-out) mencabut push browser itu. Menghapus sesi yang masih berlaku atau sudah dicabut menghapus push-nya lewat trigger `session_delete_push_subscriptions` (migrasi 0375). Sesi yang hanya kedaluwarsa karena diam 30 menit tidak memutus push, supaya HP terkunci tetap menerima alarm. Push lebih tua dari 30 hari tidak dikirim.
- Worker: alarm panik dikirim ke maks 5 subscription terbaru di outlet alarm, paralel; 404/410 menghapus baris; gagal sementara diulang. Push tidak terkonfigurasi tidak menghentikan notifikasi in-app.
- Temuan architect 791 butir 1-7 dikerjakan (provider X-Device-Token, wiring VAPID, fan-out, tanpa dead-letter saat push mati, lewati subscription rusak, gerbang area ops, kembali ke fasilitas yang sama setelah ganti PIN).
- Env baru divalidasi di `apps/api/src/config/env.ts`; setup lokal membuat pasangan kunci dev bila belum ada (tidak dicetak). Kunci produksi dibuat di server, lihat `docs/deployment.md`.

## Bukti test

- Gagal-dulu: test-writer commit c5ab92b00 di atas basis: API 44/72 gagal, web 13/16 gagal. Putaran architect v2: 10 gagal / 74 lulus. Putaran 3 (B1, sesi dicabut lewat UPDATE lalu dihapus): 2 gagal / 41 lulus.
- B2 (sesi impersonasi): test HTTP sudah hijau sebelum perbaikan karena gerbang umum `SUPPORT_ACCESS_READ_ONLY` menolak POST lebih dulu. Penolakan di `registerPush` adalah lapis kedua; tidak ada bukti merah lewat HTTP.
- Gate akhir: API 4 file 87/87 lulus (`push-registration`, `push-env`, `panic-push-fanout`, `panic-push-fallback`); root 97/97 lulus (`push-registration-web`, `panic-recovery-gate`, `setup`, `text-contract`, `notification-contract`, `db-role-provisioning`); typecheck API dan web lulus; e2e mock `e2e/legend-jztb7.mock.spec.ts` 4/4 lulus; `db:generate` kosong; prettier dan eslint file berubah bersih.
- Peringatan hidrasi React di log e2e sudah ada sebelum cabang ini (sama di run awal), tidak menggagalkan test.

## Hanya bisa diuji di ponsel nyata

- Push alarm sampai di HP Android terkunci setelah lebih dari 30 menit diam.
- iOS: push hanya jalan dari PWA yang dipasang ke layar utama (iOS 16.4+).
- Ganti PIN darurat dengan token perangkat asli, lalu kembali ke layar fasilitas yang sama.
- Izin notifikasi ditolak atau dicabut dari pengaturan HP.
- Kunci VAPID produksi dibuat di server dan sama di API dan worker.
