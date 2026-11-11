# 498 Mockup gate-ui: sisa area (sarapan tiket, label prep, payroll, notifikasi, receipt run)

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`. Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia. Keadaan normal, loading, kosong, error, sukses, validasi bila relevan.

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkas barumu, jangan `git add -A`, jangan ubah berkas yang sudah ada). Commit lokal path-scoped, lalu lapor.

- legend-ijv8: WS-09 pesan sarapan tiket (alur Z) + pengingat web-push 5 menit. Gaya `design/mockups/pos/` (`pos-extra-*`), daftarkan di `pos/README-extras.md`.
- legend-wjz1: WS-14 cetak label prep (halaman kosong, baris terpilih, teks rentang negatif). Gaya `design/mockups/pos/`.
- legend-wpqs: konfigurasi payroll, sumber legal entity untuk kebijakan pertama + jadwal THR. Gaya `design/mockups/hris/hris.html`.
- legend-rp3fk: preferensi notifikasi, toggle email wajib kategori keamanan terkunci. Gaya `design/mockups/platform/domain-verification.html`.
- legend-s7szu: banner `receiptRunAlert` untuk rotasi receipt run edge berulang. Gaya `design/mockups/backoffice/uom-7z38l.html`.

Uang (THR, payroll): angka konsisten, dicek reviewer. Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu, angka subagent.
