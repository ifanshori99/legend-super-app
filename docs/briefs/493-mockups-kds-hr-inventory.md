# 493 Mockup gate-ui: KDS, koreksi absensi HR, faktur pemasok

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`. Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia. Tiap layar: normal, kosong, error, loading bila relevan; lebar sesuai perangkat (KDS layar dapur 1280, HR 390, back-office 1280 + 390).

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkas barumu, jangan `git add -A`, jangan ubah berkas yang sudah ada). Commit lokal path-scoped, lalu lapor.

- KDS, gaya `design/mockups/pos/` (`common.css`, `common.js`, `captain.html`, set `pos-extra-*`); berkas `pos-extra-kds-<kartu>-*`, daftarkan di `pos/README-extras.md`:
  - legend-sonf: konfigurasi tampilan stasiun KDS (urutan tab, aktif/nonaktif, cetak cadangan).
  - legend-v4ht: tab stasiun KDS dengan badge jumlah per opsi (`SegmentedControl`).
  - legend-uqfu: input aksi scanner di KDS.
- legend-nvc7: koreksi absensi yang ditolak server, tampil gagal. Gaya `design/mockups/hris/hris.html` + `render.mjs`; berkas `hris-nvc7-*`.
- legend-0xnm: form faktur pemasok (baris PO, PPN/PPh23, pratinjau pencocokan). Templat `design/mockups/backoffice/uom-7z38l.html`; berkas `backoffice/supplier-invoice-0xnm-*`. Uang: hitungan PPN/PPh23 dan total konsisten, dicek reviewer.

Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu, angka subagent.
