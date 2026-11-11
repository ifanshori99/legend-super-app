# 490 Mockup gate-ui: owner dashboard / back-office (WS-11 dan lain)

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, gaya `design/mockups/backoffice/` (templat `uom-7z38l.html` + `uom-7z38l-render.mjs`; PNG `<nama>-<keadaan>-desktop|mobile.png`, keadaan normal, loading, kosong, error, sukses, validasi bila relevan). Lewati langkah "dua arah". Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>`). Bahasa UI Indonesia.

Kerja langsung di repo utama, cabang `ux/customer-order-benchmark` (thread lain juga di sana: hanya berkasmu di `design/mockups/backoffice/`, jangan `git add -A`, jangan ubah berkas yang sudah ada). Commit lokal path-scoped, lalu lapor.

- legend-egbs7: target penjualan outlet untuk owner (WS-11 F1).
- legend-vsw4q: owner menghapusbukukan nomor struk yang hilang.
- legend-5bjh: tautan laporan pemegang saham + keadaan tanpa akses `/_kelola/reports/*`.
- legend-tltue: kontrak bagi hasil + penanda "perubahan penerima menunggu persetujuan".
- legend-wwyyk: tombol "klaim bagian bagi hasil" dan keadaannya.
- legend-5tewu: pengaturan integrasi, pesan konflik nomor WhatsApp (referensi gaya: `design/mockups/platform/domain-verification.html`).

Uang (bagi hasil, target): angka konsisten antar layar, dicek reviewer. Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir. Laporan: berkas, kartu, angka subagent.
