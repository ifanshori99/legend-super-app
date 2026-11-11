# 533b Temuan architect ronde 2 atas c8d4c254 (ws/edge-catalog-fresh)
Satu putaran fix, tiap fix test gagal-dulu. Urutan:
1. P1 `promo-gate-runtime.ts:85-99`: selama jam belum terbukti, promo tetap mati. Hapus pengecualian A3 (checkpoint > high water + 125s) atau izinkan hanya setelah jam terbukti. Supaya bukti lebih sering: baca juga header `Date` dari respons pull cloud-http. Skenario: host mati 3 hari, NTP diblok, jam 3 hari mundur, bukti A2 gagal (benar), tapi A3 menyalakan promo dan `pos-order-discounts.ts:85` memakai `new Date()` mundur -> promo/voucher kedaluwarsa dipakai.
2. P2 `trusted-clock.ts:130`, `runtime.ts:788-791`: bukti hanya bila |server - (bootWall + monotonic sejak boot)| <= 5 menit (lompatan chrony setelah boot tidak dihitung). `clearReason` hanya hapus entri dengan staleSince di boot ini. Pastikan alarm terkirim walau link terbuka sebelum gate ada (`runtime.ts:1140`).
3. P2 `catalog-alarm-queue.ts:213,237-239`: sebelum kedaluwarsa umur, wajib >= ~240 kiriman lewat link terbuka (~1 jam); 7 hari diukur dengan jam terpercaya, bukan wall clock.
4. P3: `promo-gate-runtime.ts:94` catat nilai checkpoint promo saat boot, wajib berubah (bila A3 masih ada); `link-client.ts:147` simpan waktu di `upgrade`, pakai hanya saat `open`; `catalog-alarm-queue.ts:141` laporkan error selain file-not-found pada file legacy rusak.
Yang sudah aman: TLS + bearer mencegah Date palsu/replay; monotonic reset tertutup high water.
Selesai: commit lokal, test terarah + tsc api via heavy, satu reviewer sonnet atas diff, laporan singkat.
