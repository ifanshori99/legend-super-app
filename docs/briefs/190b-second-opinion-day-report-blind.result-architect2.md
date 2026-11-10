# 190b result, architect 2 (Claude double review, brief 225)

Kartu: legend-awg5p. Diff 12c91f6b..fa472534, merge 095d357e, ada di milestone/m1 (94d769c6). Tidak ada perubahan sesudahnya pada pos-day.service.ts, schemas.ts, endpoints.ts, day-close-screen.tsx.

## Hasil: Bersih (tidak ada P1/P2)

- Aturan buta tahan untuk jalur yang diubah: getEndOfDayRecap (pos-day.service.ts:666-698) memanggil blindOwnDrawer (:196-250) untuk recap terbuka maupun tersimpan. Pembaca tanpa pos.day.close yang punya shift di outlet+tanggal itu (cashierId dibandingkan lower-case, :218) mendapat: cashVarianceIdr dan expiredCashOutIdr null untuk tiap perangkat tempat ia punya shift (gagal tertutup ke semua perangkat bila tidak ada yang cocok, :230-234), semua baris metode null dan selalu lengkap (:239-244), totalVarianceIdr dan totalExpiredCashOutIdr null.
- Pengurangan yang disebut invariant tertutup: baris metode null, jadi total penjualan - refund - void tidak bisa dibandingkan dengan kas; total varian null, jadi tidak bisa dikurangi dengan varian perangkat lain yang tampil.
- Schema endOfDayBlindRecapSchema menolak baris perangkat setengah buta, recap buta tanpa perangkat buta, dan daftar metode tidak lengkap.
- closePosDay dan replay-nya hanya untuk pos.day.close (CLOSE_PERMISSIONS :100), jadi recap penuh tidak keluar ke supervisor lewat jalur tutup.
- Isolasi: query shift memfilter tenantId + outletId + businessDate; assertApprover memeriksa outlet scope (:170).
- Web: dayRecapFrom dan day-close-screen menampilkan tanda hubung untuk null, tidak mengarang 0.

## Temuan P3 (tanpa kartu)
- apps/api/src/services/pos-day.service.ts:209-219 dengan :355 dan :447/:524: blind hanya dipicu shift ber-businessDate sama dengan recap, sedangkan pesanan memakai businessDateFor(now) saat dibuat (pos-order.service.ts:617) dan void/refund memakai rentang waktu. Shift yang dibuka sebelum cutoff hari D dan berjalan melewati cutoff mencatat penjualan ke hari D+1. Supervisor itu (tanpa shift ber-tanggal D+1) membaca recap D+1 penuh, termasuk baris metode tunai yang berisi kas shift sendiri sesudah cutoff, sebelum ia menghitung. Kasus tepi (cutoff yang dilewati shift). Saran: anggap pembaca punya shift di hari itu bila ada posOrders/void/refund hari itu dengan shiftId milik pembaca, atau bila shift pembaca masih terbuka dan businessDate-nya <= tanggal recap.
- Sisa yang melekat pada desain: device totalIdr, refundAmountIdr, voidedAmountIdr dan baris kanal tetap tampil. Pada outlet satu perangkat dengan hari yang seluruhnya tunai, totalIdr - refund = kas bersih, sehingga expected bisa dihitung dari float dan gerakan kas sendiri. Supervisor juga punya order.view, jadi ia memang bisa menjumlah pesanan sendiri. Catat sebagai keterbatasan yang diterima atau putuskan di CTO.
