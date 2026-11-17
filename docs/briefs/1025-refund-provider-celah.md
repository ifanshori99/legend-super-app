# Brief 1025: refund provider, sisa celah uang

Branch kerja: ghostex/5e374ac9 (base 1020 c15dd03aa + merge 1013 c07bf2ca3). Tingkat K (uang). Aturan: jangan sampai ada pihak dibayar lebih; ragu = batasi.
Berkas nyata di `apps/api/src/services/`. Test di `apps/api/src/test/` (jalankan: `cd <worktree>; LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`, hanya SATU subagent menjalankan test/tsc sekaligus).

## Kartu A: legend-ra4lu

`fundBlockedSql` (refund fund lebih bayar, 1016) tidak memblokir bila refund provider tercatat (`payment_provider_refunds`) TANPA `evidence_id` fund. Default membatasi: refund provider tanpa evidence pada intent yang punya fund terbuka (`payment_unallocated_funds`, resolution NULL) memblokir refund fund sampai finance memutuskan. Risiko: tamu direfund dua kali (provider + kita).

## Kartu B: legend-gjt5q

Refund provider PENUH (958, `markProviderRefunded` di `payment-webhook.service.ts` ~898-912 dan `payment.service.ts` ~3355-3376, 3412) tidak menulis `payment_provider_refunds` dan tidak dijurnal. Tulis baris sekali (idempoten; kunci unik yang sudah ada) dan biarkan event jurnal 1013 `payment.provider_refunded` (kunci `aj:provider-refund:<id>`) memostingnya sekali. Setelah refund parsial sebelumnya, sisanya (full - sum parsial) yang ditulis. Replay/webhook+poller: jurnal tepat sekali.

## Kartu C: legend-9s33i

`refund.succeeded` dengan reference intent lain (1020 F3 REFERENCE_MISMATCH = ignored tanpa jejak) jangan dibuang diam-diam: catat flag recon + alert + blok payout intent (yang direferensikan/yang menerima webhook, putuskan dari kode) sampai finance mencocokkan. Tetap TANPA refund/stamp otomatis.

## Test wajib

Tamu tidak direfund dua kali; outlet tidak membayar payout atas uang yang sudah dikembalikan provider; jurnal sekali (replay, webhook+poller); flag muncul untuk mismatch; tenant lain tidak terpengaruh; kontrol 958/967/980/1009/1013/1016/1020 tetap hijau. Gagal-dulu di base. Migrasi hanya bila perlu (nomor kerja 0642-0643; cek nomor terakhir di `apps/api/drizzle`).
Berkas test baru: `src/test/refund-1025-a-*.test.ts`, `...-b-*`, `...-c-*` (satu per kartu, tidak bertumpuk).
