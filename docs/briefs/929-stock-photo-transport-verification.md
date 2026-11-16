# 929 — Verifikasi transport foto penerimaan dan kas kecil

Tanggal: 16 November 2026. Kartu: `legend-0una` (WS-06).
Cabang: `ws/929-stock-photo-transport`, basis tepat `a8e6036ab`.

## Hasil

Transport sudah diterapkan oleh `94a165b19455c33c4acb267ff05f16e0cd640d0a` (`legend-uaoli` M3) dan merupakan ancestor basis. Tidak ada perubahan kode produk, akses, uang, schema, atau migrasi pada audit ini. Tidak merge atau deploy.

- Kedua layar menormalisasi gambar, mengunggah multipart melalui `/api/storage/uploads`, lalu menyimpan ID storage dari server.
- `photo-field.tsx` memakai signed thumbnail; URL baca berlaku 300 detik dan dapat diperbarui.
- Batas JSON tetap 100 KiB. Multipart terpisah dibatasi 10 MiB, lalu policy ukuran dan pemeriksaan isi gambar berlaku di service.
- Query storage dan pengaitan penerimaan memfilter tenant di SQL; kas kecil memakai helper pengaitan storage yang ada. Tidak ada rahasia baru di browser.

## Bukti gagal-dulu historis

Arsip lokal `/tmp/legend-m3-verification.txt` mengidentifikasi basis `513f7b7fc` dan commit implementasi `94a165b19`. Log `/tmp/legend-m3-red.log` menunjukkan 0 lulus/13 gagal: callback penerimaan dan kas kecil mengirim 0 unggahan, padahal test meminta 1. Ini kegagalan perilaku, bukan kegagalan setup. Log akhir `/tmp/legend-m3-unit-final.log` menunjukkan 56 lulus/0 gagal, termasuk 20 kasus M3. Arsip tersebut diperiksa pada audit ini; bukan run merah baru.

## Verifikasi baru

`pnpm worktree:setup` selesai; fallback prefer-offline mengisi dependency yang belum tersedia. Test memakai PostgreSQL disposable, tanpa memulai server aplikasi.

Run terarah melalui `LEGEND_TEST_FILES="tests/media-screens-upload.test.mjs tests/storage-web-client.test.mjs tests/storage-web-client-mock.test.mjs src/test/core-storage-routes.test.ts src/test/core-storage-access.test.ts src/test/core-storage-service.test.ts src/test/inventory-receiving.test.ts src/test/petty-purchase.test.ts" heavy pnpm test` lulus: 3 berkas root, 43 test; 5 berkas API, 80 test, exit 0. Log lokal `/tmp/legend-929-tests.log`. Mencakup kedua callback layar, multipart, signed read, validasi, isolasi storage, penerimaan, dan pembelian kas kecil.

## Review dan batas

Satu reviewer konteks segar: tidak ada blocker transport. Penerimaan belum memakai penguncian source storage seperti kas kecil; ini concern pengaitan/akses yang sudah ada, di luar brief tanpa perubahan akses. CTO dapat menindaklanjutinya terpisah. Tidak mengubahnya pada audit ini.

Build, typecheck, e2e, provider storage nyata dan ClamAV tidak dijalankan ulang karena kode produk tidak berubah. Tidak ada migrasi baru sehingga nomor 0670 tidak dipakai.

Subagent: 6 total, puncak 6 bersamaan; token heavy dipegang `test_runner`. `session-usage.py` tidak menemukan transkrip Codex; `parallel-report` hanya membaca sesi Claude, sehingga biaya/token serta rata-rata native Codex tidak tersedia.

## Pra-gate

`pnpm exec prettier --check docs/briefs/929-stock-photo-transport-verification.md docs/PROGRESS.md` hijau. `pnpm exec eslint tests/media-screens-upload.test.mjs tests/storage-web-client.test.mjs tests/storage-web-client-mock.test.mjs` hijau. Markdown tidak memiliki pemeriksaan ESLint. `git diff --check` hijau. Tidak ada perubahan katalog/kontrak atau schema yang memerlukan gate tambahan.
