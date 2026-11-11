# 492 Mockup gate-ui: perjalanan pelanggan QR dan tamu

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, gaya `design/mockups/final-a-*` (dasar `final-a-mobile.html` + `final-a-mobile.css`; acuan `final-a-menu-mobile.png`, `final-a-detail-mobile.png`; render `capture-final-a.mjs`). Untuk legend-oamb pakai templat `design/mockups/backoffice/uom-7z38l.html`. Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia. Tiap layar: normal, kosong, error, loading bila relevan; utamakan 390, plus 1280 bila dipakai di desktop.

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkas barumu, nama `qr-<kartu>-*` di `design/mockups/`, jangan `git add -A`, jangan ubah berkas yang sudah ada). Daftarkan layar di `design/mockups/README-qr.md`. Commit lokal path-scoped, lalu lapor.

- legend-8qri: kerangka perjalanan pelanggan QR dengan tema merek tenant dan zona waktu outlet.
- legend-tct6: kartu menu QR dan lembar item dengan foto dari pustaka media.
- legend-d6d1: lanjutan booking tamu (tautan DP tidak ditemukan, daftar zona publik, notifikasi waitlist).
- legend-vnvg: ajakan menautkan WhatsApp di layar member dan poin (AUTH-07).
- legend-oamb: lembar QR cetak, batch dan grid label A4 (back-office).

Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu, angka subagent.
