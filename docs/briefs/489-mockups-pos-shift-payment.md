# 489 Mockup gate-ui: kasir shift, diskon/void/refund, pembayaran (WS-04)

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, gaya `design/mockups/pos/` (`common.css`, `common.js`, `cashier-main.html`, `payment.html`, contoh `pos-extra-kfkt-*`). Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia. Tiap layar: normal, kosong, error, loading bila relevan; 390 dan 1280.

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkasmu, jangan `git add -A`). Jangan ubah berkas mockup yang sudah ada; tambah layar baru `pos-extra-<kartu>-*` dan daftarkan di `design/mockups/pos/README-extras.md`. Commit lokal path-scoped, lalu lapor.

Langkah 1: cek cakupan `shift.html`, `supervisor.html`, `payment.html`, `edc.html`. Kartu yang sudah tercakup penuh: laporkan saja (layar mana), jangan digambar ulang; tercakup sebagian: gambar hanya keadaan yang kurang.
- legend-7mlf (P1): buka/tutup shift kasir, tutup paksa, countId.
- legend-2fo (P1): diskon, void, refund dengan override manajer + pratinjau struk.
- legend-5w6 (P1): panel bayar: kembalian tunai, QRIS di layar pelanggan, pilih EDC.
- legend-p7lx (P2): sisa bayar setelah DP dipakai (`depositAppliedIdr`).
- legend-6om3 (P2): baris inbox persetujuan berisi selisih tutup shift.

Uang: angka di tiap layar harus konsisten (subtotal, diskon, DP, sisa, kembalian) dan dicek ulang oleh reviewer. Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu (digambar / sudah tercakup), angka subagent.
