# 192b hasil architect (legend-yd0h8), 9 Nov 2026

Diperiksa di `integ/m1-batch28` 1f83d4aa. Merge yd0h8: 9b681bea (b6d6c8b4). Kode sesudahnya diubah oleh hfq3z (belum di m1) dan diperiksa di 204b.

**Bersih.** Tidak ada temuan P1/P2.

Yang dicek:
- Laporan normal: `reported >= high` hanya menaikkan high-water. Tidak ada rotasi (pos-receipt.service.ts:1126-1146). Retry bertahap di fetcher mengirim laporan yang sama, jadi bukan regresi.
- Token `tau` diambil dari waktu tiba di cloud, sebelum cek kredensial. Request lama yang tertahan lock datang dengan tau yang lebih kecil, lalu dilewati sebagai stale (:1122-1125). Trigger menjaga `edge_reported_at` dan high-water supaya tidak mundur.
- Regresi memensiunkan run (`edge_regressed`, cap tau) dan memberi prefix baru. Throttle-nya 2 per perangkat per node per 24 jam, lalu `alert`. Cek clone membandingkan laporan prefix pensiun di atas high-water beku dengan token yang lebih baru.
- EDG-02: laporan yang gagal tidak menghentikan pull (edge-device-sync.ts:865-873). `receiptRunAlert` dipisah sebelum parse ketat. Alert hanya dikirim ke edge yang mengirim `receiptRuns`.
- Kompatibilitas: edge lama tidak mengirim laporan, jadi tidak ada cek dan tidak ada field baru. Edge baru di cloud zsdd mendapat 400, lalu mengulang tanpa `receiptRuns`.

P3 (catatan, tanpa kartu):
- Batas yang sudah diketahui tetap berlaku: penjualan sesudah restore sebelum pull pertama (legend-ol6v), dan delay jaringan > 15 s yang bisa memicu regresi palsu. Regresi palsu hanya memutar prefix (aman, ada alert).
- Jalur lama: edge yang memegang prefix sama untuk run lain (sesudah restore cloud) bisa menaikkan high-water run cloud dengan angka run lain. Jalur ini sudah ditangani hfq3z (`prefix_used` dilewati).
