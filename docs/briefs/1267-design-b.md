# 1267 Bagian B (founder 25 Nov: "kerjakan sesuai rekomendasi kamu")

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-1267`, cabang `ws/1267-design-b` dari milestone/m1 9fcac9be1. Aturan umum sama dengan brief 1265. UI ikut `~/.agents/team/ui-standard.md` dan `DESIGN.md`. Teks UI baru masuk katalog teks.

## 16: pemilih QRIS/EDC saat menagih tukar menu (legend-t93l8, uang)

API `collectCharge` sudah menerima tunai/QRIS/EDC (legend-khvqb, af6845a55); UI baru tunai. Bangun pemilih metode di dialog tagih tukar menu dengan memakai ulang pola dan komponen pembayaran POS yang sudah disetujui (mockup `design/mockups/pos/payment.html`, `edc.html`; komponen kasir yang ada). Mockup kecil statis satu berkas di `design/mockups/pos/` dulu, lalu UI.
- QRIS: QR + sisa waktu + polling; kedaluwarsa, gagal, buat ulang. EDC: pilih transaksi EDC sah dari server, jangan ketik nominal sendiri. Status unknown/menunggu: tidak boleh ganti metode atau tagih ulang sampai server menyatakan aman.
- Nominal selalu dari server. Klik ganda, dua tab, refresh di tengah, kembali dari jaringan putus: tidak boleh bayar dobel atau tukar menu selesai tanpa bayar. Kunci idempotensi tetap sama untuk percobaan ulang.
- Bila API kurang (mis. daftar transaksi EDC atau status), jangan karang: pilih aturan paling membatasi dan laporkan. Perubahan backend hanya bila perlu, kecil, dan dengan test gagal dulu.
- Bukti: test unit/komponen untuk jalur di atas (gagal dulu), screenshot 390 dan 1280 ke `docs/review/img/1267-tukar-*.png` (browser lewat `heavy --browser`), prettier, eslint, text-contract, tsc web (+api bila disentuh).

## 15: audit layar fasilitas, pembayaran, Wi-Fi, HRIS (legend-5c0a)

Audit baca saja terhadap DESIGN.md v2; temuan nyata (bukan selera) diberi berkas:baris, dampak, perbaikan. Lalu diperbaiki di gelombang kedua. Keadaan kosong, galat, memuat, 390/1280, kontras, fokus, target sentuh 44px, teks Indonesia.

## 17 dan 18: katalog laporan; dialog koreksi PTKP, batal persetujuan bagi hasil, banner payout beku

Audit baca saja: katalog 105 laporan jujur ("Segera hadir" hanya untuk yang belum tersambung, tidak ada angka palsu, tautan mati), dan ketiga UI no. 18 aman (alasan wajib, konfirmasi jelas, tidak bisa dua klik, izin benar, banner terlihat di 390). Rekomendasi CTO: terima bila tidak ada temuan berat.
