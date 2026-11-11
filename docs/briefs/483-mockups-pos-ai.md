# 483 Mockup gate-ui: kasir utama + captain (WS-04), Tanya AI + MCP (WS-12)

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, gaya mockup yang ada di `design/mockups/pos/` (HTML + render.mjs -> png). Lewati langkah "dua arah": langsung layar final.

Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (bagian yang dirujuk tiap kartu, `bd show <id>`). Bahasa UI Indonesia.

## Bagian A (thread A): WS-04, folder `design/mockups/pos/`
- legend-59v kasir utama (tablet landscape 1280 + 390): cari menu, modifier, catatan, kanal (dine-in/takeaway/online), hold & fire, keranjang. Keadaan: kosong, modifier wajib belum dipilih, stok habis, offline (katalog belum diperbarui sejak HH:MM: peringatan, tetap bisa jual).
- legend-76t captain order di HP waiter (390): pilih meja, tambah item, kirim ke dapur, panggilan waiter masuk. Keadaan: meja terisi, offline.
Berkas: `cashier-main-*.png`, `captain-*.png` + html sumbernya.

## Bagian B (thread B): WS-12, folder `design/mockups/ai/`
- legend-mlnu Tanya AI (1280 + 390): jawaban dengan sumber, label "Dibantu AI", AI tidak tersedia, hapus riwayat.
- legend-jk6s detail permintaan aksi AI (draf aksi menunggu persetujuan) + halaman panduan.
- legend-39d.1 halaman `/mcp/consent` (izin klien MCP: nama klien, cakupan akses, setujui/tolak).
- legend-hi82 admin MCP & AI: tabel klien, cabut token, kill switch, kuota.
Berkas: `<layar>-desktop.png`, `<layar>-mobile.png` + html sumbernya.

Commit path-scoped hanya folder bagianmu. Laporan sesuai peran: path gambar, 3 keputusan desain, asumsi untuk founder.
