# 985 Charge tukar menu sisa: refund tunai/EDC, status setelah void, indeks outbox

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/982-charge-tukar-menu-refund-void-pos` (2ba47d846; belum di m1). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0565-0569 (nomor kerja); 982 memegang 0550.

Konteks wajib: laporan 982 di `docs/PROGRESS.md` cabang itu (refund charge lewat intent, void membalik charge dalam satu transaksi, EDC 409, collect-at-pos QRIS/EDC).

Kartu (`bd show <id>`; claim dulu):
- legend-mrwtp: charge tunai/EDC tidak punya payment intent sehingga refund ditolak 409. Buat jalur refund manual: tunai keluar dari laci kas shift aktif (tolak bila kas tidak cukup atau shift tutup), EDC dicatat sebagai refund manual dengan referensi; persetujuan ber-izin, jurnal balik, total tidak melebihi nilai charge.
- legend-v5z4h: charge gateway yang sudah habis direfund tetap `paid` setelah void order. Selaraskan status (refunded/voided) supaya laporan dan rekonsiliasi tidak menghitungnya pendapatan.
- legend-9e21l: `chargeInUseOfIntent` mencari JSON outbox tanpa indeks. Tambah indeks atau kolom terstruktur (migrasi, cek EXPLAIN).

Jangan sentuh: refund/recon provider (980), akses Tanya AI/perangkat kasir (984), payroll/HR (983), UI web.

Jangan sampai rugi: test bukti (1) refund manual + refund intent + void tidak pernah melebihi nilai charge, termasuk bersamaan, (2) kas laci tidak bisa negatif, (3) status charge setelah void konsisten dengan uang yang benar-benar kembali, (4) jurnal seimbang, (5) tenant/outlet lain tidak tersentuh. Bila ragu: blok pembayaran.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (#9): lint, typecheck API, test terarah grup order-issue/refund/pos-cash, `db:generate` kosong, prettier. Satu token heavy per thread; typecheck sekali per putaran perbaikan. Jangan jalankan `pnpm check` atau `pnpm test` penuh (tugas merge train). Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal (tanpa tick).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
