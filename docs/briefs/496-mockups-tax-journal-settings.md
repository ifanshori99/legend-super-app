# 496 Mockup gate-ui: pajak, jurnal per outlet, menu stasiun, hub pengaturan

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, gaya `design/mockups/backoffice/` (templat `uom-7z38l.html` + `uom-7z38l-render.mjs`; tabel/daftar: `account-role-mappings.html`; PNG `<nama>-<keadaan>-desktop|mobile.png`). Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia. Keadaan normal, loading, kosong, error, sukses, validasi bila relevan; 1280 + 390.

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkas barumu di `design/mockups/backoffice/`, jangan `git add -A`, jangan ubah berkas yang sudah ada). Commit lokal path-scoped, lalu lapor.

- legend-woc1: aturan pajak WS-05, target item dan kategori, versi khusus outlet, buang draf.
- legend-d5pz: peringatan sebelum menonaktifkan satu-satunya aturan pajak food_beverage.
- legend-5ac3: atribusi outlet di baris jurnal manual dan berulang (WS-07).
- legend-0frf: admin menu, tipe stasiun per item (`stationType`) + override stasiun opsional.
- legend-j0kd: hub pengaturan yang menautkan integrasi tenant, tema, syarat, dan halaman konfigurasi.

Uang (pajak, jurnal): angka konsisten (debit = kredit, pajak benar), dicek reviewer. Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu, angka subagent.
