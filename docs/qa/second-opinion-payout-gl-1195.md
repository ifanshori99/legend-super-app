# Second opinion 1195 — payout GL holds (1184)

Tanggal: 19 November 2026. Hasil: **Tidak ditemukan temuan P0–P3 dengan skenario gagal konkret dalam lingkup review.**

## Lingkup dan cara verifikasi

- `git fetch origin` berhasil; head `origin/ws/1184-payout-gl-holds` sesuai brief: `356b357e6fc223c3f14fa7bde8a75bf0527505de`.
- Diff yang diperiksa: `git diff origin/milestone/m1...origin/ws/1184-payout-gl-holds -- apps/api packages/shared`; merge base `d99aae067ed11342e97b00ebc01c5c5104540af6`. Nomor baris di bawah merujuk head tersebut.
- Tiga subagent read-only berjalan paralel: biaya saldo pembukaan, pelepasan payable hold, serta migrasi/izin. Hasil digabung dan pemeriksaan penting dicocokkan kembali dengan kode.
- Tidak melakukan checkout, membuat worktree, mengubah kode, menjalankan layanan, atau commit. Satu-satunya berkas yang ditulis adalah laporan ini.

## Invarian yang diperiksa

- Biaya saldo pembukaan: `apps/api/src/services/payroll-payout-gl-holds.service.ts:128` memeriksa alasan aktual `accounting_was_off`; perubahan, identitas penyetuju, catatan, waktu DB, dan audit dilakukan dalam satu transaksi (`:139`, `:155`). Biaya keluar dari daftar pemulihan/pengecualian dengan jejak tersimpan pada posting dan audit.
- Tidak dijurnal ulang: `apps/api/src/services/payroll-payout-gl.service.ts:1021`, `:1134`, `:1406`, dan `:1537` menutup jalur resolver, posting biaya, serta pemilihan biaya untuk retry/repost. Penandaan biaya tidak meniadakan penyelesaian neto yang masih diperlukan. Jalur mark dan penulis jurnal normal berbagi urutan kunci run → batch → entitas → advisory → posting.
- Pelepasan hold: `apps/api/src/services/payroll-payout-gl-holds.service.ts:194` menolak akun beku kosong; `:198` memerlukan setidaknya satu debit pada jurnal ber-key posting, dalam tenant yang sama, dan menolak setiap debit ke akun lain. Guard `apps/api/drizzle/0715_payout_gl_holds.sql:166` mengulang bukti ini. Jalur retur tetap memakai akun payable beku, tanpa menggantinya dengan mapping hari ini.
- Otorisasi: kedua endpoint di `apps/api/src/routes/payroll-payout.routes.ts:465` dan `:485` memerlukan sesi, trusted origin, konteks tenant, izin baru, MFA segar, dan middleware step-up payout. Pembuat batch ditolak oleh `apps/api/src/services/payroll-payout-gl-holds.service.ts:89`; pembacaan dan perubahan posting selalu difilter tenant. Pemeriksaan batch beku dilakukan sebelum perubahan.
- Migrasi/izin: `apps/api/drizzle/0715_payout_gl_holds.sql:134` dan `:166` hanya membuka transisi mark/release yang ditentukan; enam kolom resolusi ditolak pada INSERT (`:260`). `apps/api/drizzle/0716_payout_gl_resolve_grants.sql:25` hanya memperbarui template Owner/Finance per tenant dan tidak menggandakan kode izin. Template baru mengikuti penerima yang sama.
- Perbandingan programatis badan fungsi SQL berhasil: setelah penambahan yang disengaja dikeluarkan, guard UPDATE 0412 dan INSERT 0415 tetap sama dengan 0715. Pemeriksaan JSON juga berhasil untuk hubungan ID/prevId, kesamaan skema snapshot 0715–0716, dan indeks jurnal migrasi.

## Batas dan usul test

Test aplikasi, eksekusi migrasi PostgreSQL, lint, typecheck, dan build **tidak dijalankan** pada review read-only ini. Dua berkas test `payroll-payout-1184-fee-opening-balance.test.ts` dan `payroll-payout-1184-payable-hold-release.test.ts` dibaca; keberadaannya bukan bukti bahwa test lulus.

Pemeriksaan whitespace laporan dengan `git diff --no-index --check /dev/null docs/qa/second-opinion-payout-gl-1195.md` berhasil. `pnpm exec prettier --check docs/qa/second-opinion-payout-gl-1195.md` tidak dapat dimulai karena modul lokal `node_modules/prettier/bin/prettier.cjs` tidak tersedia; dependensi tidak dipasang atau diubah.

Usul penguatan berikut bukan temuan bug:

- Pada test payable hold, tambahkan jurnal dengan debit campuran A (akun beku) dan B. API harus menjawab 409, UPDATE langsung harus ditolak guard, dan hold/audit/jurnal tetap tidak berubah; ini melengkapi kasus seluruh debit dipindahkan ke B.
- Tambahkan test DB untuk mark/release yang sekaligus mencoba mengubah kolom lain, penyisipan posting yang sudah bertanda resolusi, serta pengubahan/penghapusan metadata resolusi sesudahnya. Semua harus ditolak tanpa efek.
- Tambahkan fixture backfill 0716 dengan template Owner/Finance, template HR/GM/admin, custom role, dua tenant, dan izin yang sudah ada. Hanya dua template yang dimaksud menerima satu kode baru.

Pola step-up yang ditetapkan untuk slice ini menerima challenge MFA sah yang masih segar sebagai pengganti password; password diwajibkan bila stamp berasal dari enrollment saja. Perilaku tersebut mengikuti middleware payout yang dipilih dalam desain, sehingga tidak dihitung sebagai bypass password pada review ini.
