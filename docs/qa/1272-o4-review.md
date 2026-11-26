# Review K O4 kasir offline (ws/1272-o4)

Reviewer: architect (Opus), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 1 P1, 3 P2, 2 P3. Re-review: diff perbaikan P1/P2 + test.

## Aman
- `recordSale` tolak total beda dan tunai kurang; `cashOf` = tunai masuk laci. Tutup shift ditahan di tablet dan server (`shift-api.ts:436`). Sheet antrean tanpa hapus. Server tutup paksa: orang ketiga, hitungan terakhir belum basi, override dihitung server, alasan >= 10 huruf.

## P1 (kafe bisa terkunci)
Layar tutup paksa `/pos/supervisor/shift/$shiftId` tidak punya link. `offline-close-block.tsx:102` hanya teks; `OFFLINE_QUEUE_UNVERIFIED` tidak ditangani di web. Fix: oper `shift.data.id` dari `blind-count-screen.tsx:207` ke `OfflineCloseBlock`, link tutup paksa di sana dan di error 409; baris shift terbuka bisa diklik di `day-close-screen.tsx`; test link.

## P2
1. `offline/sale-guard.ts:49`: keranjang hanya ditahan bila persis sama. Fix: tolak bila ada satu baris (item, varian, opsi) sama dengan baris pending. Test "pending + 1 item -> uncertain_order".
2. `cashier-main-screen.tsx:698-713`: bayar offline tanpa cek `canAcceptPayment`. Fix: alasan tolak `noPermission` + test.
3. `offline/connectivity.ts:48-79`: ping `no-cors` menganggap jawaban HTTP apa pun online (VPS mati di balik Cloudflare 52x = tablet terkunci).

## P3
- `shift-approval-screen.tsx:678`: tombol tutup paksa juga untuk `COUNT_NOT_SUBMITTED`.
- `shift-force-close.tsx:284-287`: filter saksi pakai `sameUser`.

## Keputusan CTO 27 Nov
- P1, P2 #1, #2, P3: dibetulkan sesuai saran.
- P2 #3: `/api/health` dibaca lintas origin hanya untuk `WEB_URL` + `TRUSTED_ORIGINS` (GET, tanpa cookie, tanpa data rahasia); tablet hitung status >= 500 atau timeout sebagai gagal, 2 gagal = offline. Test: 502 -> offline, 200 -> online.
- Screenshot `docs/review/img/o4-*` wajib sebelum gabung (spec `e2e/o4-offline-shots.spec.ts`, `O4_SHOTS=1`), lalu ui-auditor.
- Screenshot (27 Nov): mode mock tidak punya bekal/antrean offline. Diputuskan opsi B: 5 adegan mock sekarang (banner tanpa bekal + 4 langkah tutup paksa); adegan bayar/tersimpan/antrean/blok tutup/keluar masuk O5 dengan domain tenant tes di browser nyata. Tidak menambah jalur mock di kode produksi.
