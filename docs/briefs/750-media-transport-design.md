# Brief: architect — desain transport media dan pemindai dokumen (legend-0una, legend-2t69x)

## Peran
Baca `~/.agents/team/roles/architect.md` dan hanya bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Kerja baca saja dan satu dokumen desain; tidak ada kode produk, tidak ada test berat (tidak perlu `heavy`).

## Tujuan
Satu desain yang menyatukan dua kartu, supaya engineer bisa membangunnya setelah batch payout (64c) masuk:
1. legend-0una: layar penerimaan barang dan pembelian kas kecil memakai photo-field.tsx tetapi belum ada endpoint unggah foto dokumen stok (hanya uploadMenuImage). Mock menyimpan data URL dan id media lokal. Butuh kontrak media (POST /api/media atau path storage adapter) plus read model signed URL, lalu wiring kedua layar.
2. legend-2t69x: pemindai malware produksi `acceptsDocuments:false`, jadi unggah bukti payout PDF dijawab 503 (JPEG/PNG jalan, di-encode ulang sharp dengan NoopMalwareScanner). Kartu ini menyambungkan pemindai yang bisa memeriksa PDF (juga dokumen pemegang saham). Fail-closed tetap. Second opinion: validasi struktur PDF sebelum simpan (awalan %PDF- saja tidak cukup).

## Masukan
- Cabang payout yang sedang mengubah penyimpanan bukti: `ws/payout-api-gaps` (adde2aebe), `ws/payout-evidence-hardening` (2633c2195), `ws/payout-followups`. Baca lewat `git show`/`git diff origin/milestone/m1...<cabang>`; desain harus memakai ulang storage adapter dan pemindai dari cabang itu, bukan membuat jalur kedua.
- Server produksi: VPS milik founder (belum dibeli, Q20). Pertimbangkan RAM pemindai (mis. ClamAV daemon) dan biaya; bila ada pilihan berbayar, tulis biaya bulanan dan satu rekomendasi.

## Scope
- Tulis: `docs/design/media-transport.md` saja.
- Jangan ubah kode, migrasi, atau cabang lain.

## Pembagian paralel (giliran pertama)
- Explore (3): (a) storage adapter dan pemindai di cabang payout di atas; (b) photo-field.tsx, layar penerimaan dan kas kecil, uploadMenuImage; (c) RBAC/ownership foto per outlet dan signed URL yang sudah ada.

## Isi desain
Kontrak endpoint (zod di packages/shared), tabel atau kolom (beri tahu bila butuh migrasi; nomor diberikan CTO nanti), alur signed URL dan masa berlakunya, batas ukuran dan tipe, pemindai (gambar vs PDF, fail-closed, validasi struktur PDF), akses per outlet, potongan kartu untuk engineer (3 sampai 6 kartu, file terpisah), urutan terhadap batch 64c, keputusan yang butuh founder (bila ada, dengan dampak biaya).

## Sebelum melapor
Commit `docs/design/media-transport.md` di cabang `docs/media-transport-design` (buat dari `origin/milestone/m1`, di worktree sementara bila perlu, hapus setelah push) dan push tanpa force.

## Laporan
Ringkasan desain (maks 10 baris), potongan kartu, keputusan untuk founder, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
