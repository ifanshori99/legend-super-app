# Brief: designer — mockup POS kasir: pembayaran lengkap + shift kasir

## Peran

Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/TEAM.md`, lalu ikuti. Aturan UI: `~/.agents/team/ui-standard.md`. Sistem desain: `DESIGN.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, cabang `ux/customer-order-benchmark` (aktif di folder ini). Jangan pindah cabang. Hanya tulis di `design/mockups/pos/`.

## Tujuan

Mockup layar kasir (POS, tablet landscape 1280x800 utama) untuk dua alur yang sedang dibangun backend-nya:

1. **Pembayaran di kasir**: pilih metode QRIS, Virtual Account, E-wallet, Kartu kredit/debit, Tunai, dan **EDC** (nominal terkunci, menunggu hasil mesin EDC, cek status sebelum ulang, mode standalone dengan PIN supervisor). Split tender, kembalian tunai, QRIS kedaluwarsa, pembayaran gagal, pakai DP reservasi.
2. **Shift kasir**: buka shift (modal awal), kas masuk/keluar, tutup shift dengan blind count (kasir tidak melihat angka sistem), selisih butuh persetujuan supervisor, tutup harian.
   Juga: kode "Bayar di kasir" dari pelanggan QR diterima kasir (lihat `design/mockups/final-a-kode-kasir-mobile.png`).

## Masukan

- Layar POS yang ada: `apps/web/src/routes/_ops/pos.*.tsx` (lihat tampilannya untuk konsistensi; jalankan preview mock bila perlu, port 3102, `VITE_API_MOCK=true`).
- PRD `docs/PRD.md`: fitur POS, pembayaran, EDC, shift (cari F11–F15).
- Bead: `legend-6c0` (shift), `legend-m0k` (EDC), `legend-b0au` (QRIS tender), `legend-94qt` (DP reservasi).
- Palet: POS tetap ikut `DESIGN.md` (bukan palet QR pelanggan). Kerja cepat, sentuh besar, terbaca dari jarak 60 cm.

## Bukti selesai

- PNG per layar di `design/mockups/pos/` + `design/mockups/pos/README.md` (daftar layar, keputusan, asumsi, pertanyaan untuk founder).
- Semua gambar dibuka sendiri: tidak terpotong, kontras AA, tidak ada teks acak.
- Commit lokal: `docs(design): mockup POS pembayaran dan shift kasir`. Hanya file `design/mockups/pos/**` (cek `git diff --cached --name-only` sebelum commit; jangan ikutkan file lain).

## Laporan

Path gambar, 3 keputusan utama, pertanyaan untuk founder, asumsi.
