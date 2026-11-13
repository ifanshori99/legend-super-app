# U5b putaran perbaikan 1 (ui-auditor + impeccable-finish-reviewer)

Jangan jalankan tsc/e2e/ui-check (agent yang jalankan). eslint + prettier berkas berubah saja. Jangan commit. Teks baru ke katalog i18n.

## S35 (ws02-edge, edge-nodes-page.tsx, nav.ts, nodes-mock.ts, messages/edge-nodes.ts)
1. Menu "Status edge" di nav hanya tampil bila `API_MOCK` (kontrak belum ada); catat di CONTRACT-GAPS.md: nyalakan saat API cloud siap.
2. Mode mock: pill "Contoh data" seperti layar akuntansi (lihat key di messages/id.ts ~288 / ws07-accounting) di halaman ini.
3. Alert struk berulang: `<details>` "Petunjuk untuk administrator teknis" terbuka default (mockup).
4. Garis ganda: section node pertama tanpa border-t.
5. Selama memuat: skeleton setinggi alert di atas kartu (cegah loncatan layout).
6. Layar pending kontrak: tambah Link ke `/operasional/koneksi`.
7. Teks kosong: "outlet Anda", plus petunjuk cara mendaftarkan node (perangkat edge dipasang dari layar Koneksi & Cetak kasir) dengan tautan.
8. Banner "Status berhasil diperbarui": ikon CircleCheck, hilang setelah ~5 detik atau saat refetch berikut.
9. Demo baru `?demo=terputus` (satu node `link: "disconnected"`, satu `lastUpdatedAt: null`).

## S31 (ws07-accounting)
1. Urutan fokus = urutan visual: DOM tombol diurutkan Ajukan, Simpan draf, Batal untuk mobile; desktop pakai `sm:flex-row-reverse`/`sm:order-*` agar tampilan desktop tetap sama.
2. `aria-live` hanya pada status Seimbang/Belum seimbang, bukan seluruh panel.
3. Selisih: tambah arah ("debit lebih"/"kredit lebih") di panel, nilai tetap mutlak.
4. Sukses ajukan: di halaman detail tampil banner hijau "Jurnal berhasil diajukan untuk persetujuan." (mis. search param `diajukan=1` atau state router), ganti toast info biru itu (tidak ada toast yang menimpa kartu).
5. Halaman detail jurnal berstatus menunggu persetujuan: tombol "Setujui dan bukukan" disembunyikan/nonaktif bila pengguna = pemohon (bandingkan id pembuat di DTO detail dengan session user). Tampilan saja, API tetap penentu. Bila DTO tidak punya id pembuat, jangan ubah; laporkan.

## Skrip scripts/ui-check-u5b.mjs
1. State baru `s35-disconnected` (`?demo=terputus`).
2. Pass tema gelap 1280+390 untuk s35-alert, s31-unbalanced, s31-submit-success (pola tema gelap: cari cara set tema di apps/web, mis. cookie/localStorage/`colorScheme: "dark"` Playwright).
3. Sesuaikan s31-submit-success: harapkan banner hijau di detail, bukan toast; s35 cek pill "Contoh data".
