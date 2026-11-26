# EDC otomatis tanpa mini PC (founder no. 32, 27 Nov)

Kajian architect (Opus xhigh), dasar int/rc2 843c3ed80. Keputusan CTO: **diterima**.

## Keputusan
Aplikasi Android kecil di tablet kasir ("Legend EDC Bridge"). Agent EDC E1-E7 (`apps/api/src/edge/edc/agent.ts`: write-ahead, idempotensi, `unknown` -> inquiry, cek nominal, PAN disamarkan) dijalankan di cloud. Kasir tetap PWA. Jembatan = foreground service, WSS keluar ke API, bicara ke EDC lewat LAN (TCP IP:port) atau USB-serial. Jembatan hanya pipa; semua aturan uang di cloud.

## Kenapa bukan jalur lain
- ECR cloud bank: tidak ada bukti publik BCA/Mandiri/BRI/BNI menyediakan. Integrator (Accurate, Kasir Pintar, DealPOS, majoo-BRI) memakai LAN/USB lokal; DealPOS (POS web) memakai middleware lokal. Tetap ditanyakan ke bank, bukan jalur kritis.
- App-to-app di EDC Android bank: butuh MDM/kemitraan/whitelist bank, berbulan-bulan.
- PWA langsung: browser tidak bisa TCP; Web Serial Android baru Android 17; Chrome 142 butuh izin akses jaringan lokal; intent RawBT tidak mengembalikan hasil. Membungkus POS jadi APK ditolak (ganti distribusi POS).

## Pengaman wajib (test gagal-dulu)
1. Hasil hilang sesudah approved: jurnal lokal jembatan, kirim ulang sampai ack cloud. Cloud timeout = `unknown` -> inquiry. Bank tanpa inquiry: cek di mesin + rekonsiliasi H+1.
2. Perintah ganda: jembatan menolak sale kedua untuk trace/key sama, memutar ulang hasil pertama; tidak pernah mengulang sale, hanya inquiry.
3. "dispatched" = sudah terkirim ke jembatan; ragu sesudahnya selalu `unknown`, tidak pernah `failed`.
4. Satu EDC satu tablet: lease per terminal di cloud.
5. ACK/NAK/LRC dikerjakan jembatan lokal (latensi 4G); isi pesan per bank di kode TS cloud.
6. Jembatan mati: `EDC_AGENT_NOT_READY` -> EDC manual X1 (penjaga `pos-edc-standalone.ts` menolak manual selama sale pending/unknown).
7. BRI belum dikenal (`edcBankSchema`, CHECK `bank IN (...)` di `db/schema/edc.ts`): migrasi bila dipakai.

## Kartu kerja
- B0 founder + bank (legend-mooi): jalur kritis.
- B1 kontrak jembatan `packages/shared/src/edc/bridge.ts` (hello/lease, sale|cancel|inquiry|void, hasil, ack) + token perangkat per tablet.
- B2 agent di cloud: `apps/api/src/edge/edc/cloud-runtime.ts`, `bridge-provider.ts`, `routes/edc-bridge.routes.ts` (WSS), migrasi perangkat + lease + BRI; `pos-edc-request.service.ts` pakai resolver per outlet, bukan `getEdgeEdcAgent()`.
- B3 aplikasi `apps/edc-bridge-android/` (Kotlin, foreground service, WSS, TCP, usb-serial-for-android, jurnal Room) + emulator jembatan Node untuk test.
- B4 UI kasir (legend-osqou.19): kirim ke EDC, menunggu, batal, "cek di mesin", jalan keluar manual.
- B5 adapter bank pertama (legend-osqou.20/vpx) + simulator format bank.
- B6 e2e lewat emulator jembatan (legend-osqou.21). B7 uji lapangan terminal asli (qa + founder). Second-opinion sebelum gerbang rilis.

## Dari founder dan bank
- Per outlet: bank, merek/model EDC, koneksi (LAN/USB/Wi-Fi), Android atau bukan.
- Mulai SATU bank (saran BCA: spesifikasi paling umum di POS pihak ketiga).
- Ke bank: dokumen ECR (biasanya NDA), nyalakan mode ECR di terminal, terminal uji/UAT, syarat sertifikasi; tanya ECR cloud.
- Kabel LAN EDC ke router.
- Bila spesifikasi bank belum tiba saat sistem lain siap: keputusan founder (tunda rilis atau jalan dulu EDC manual).

Sumber: DealPOS BCA, Accurate BCA, majoo-BRI, majoo ECR, BNI EDC, Yokke ECR, Chromium Web Serial Android, Chrome Local Network Access, KOMOJU Terminal (tautan di laporan architect).
