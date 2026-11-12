# Fix 539-U5a dari ui-auditor + impeccable-finish-reviewer

Konteks: `docs/briefs/sub-539-u5a.md`, `docs/briefs/sub-539-u5a-map.md`. Mockup: `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/{platform,backoffice}/` (HTML = sumber copy).

Aturan:
- Edit HANYA berkas di bagian layarmu.
- JANGAN commit, karena agent utama yang commit.
- Jangan jalankan tsc, vitest, Playwright, atau `heavy`. Boleh menjalankan `pnpm --dir apps/web exec eslint <berkas>` dan `pnpm --dir apps/web exec prettier --write <berkas>` pada berkas yang kamu ubah.
- Bila logika di `*-state.ts` berubah, perbarui test node di `tests/` milik layar itu.
- Laporan maks 10 baris: berkas diubah, keputusan, dan yang tidak dikerjakan.

Pola live region (dipakai di beberapa layar):
- Contoh benar ada di `ws01-platform-tenants/components/restore-section.tsx:158-170`.
- Wadah `role="status"` atau `aria-live` harus sudah ada sebelum pesan muncul, lalu isinya diisi kemudian.
- Jangan memasang wadah itu bersamaan dengan isinya.

## S1 restore (`ws01-platform-tenants/components/restore-section.tsx`, `packages/shared/src/i18n/messages/ws01-platform-tenants.ts`, `restore-state.ts`, `tests/nb4iy-restore-ui.test.mjs`)
1. Keadaan `blocked`: tombol "Kembali ke daftar" (`k("backToList")`) yang menavigasi ke daftar tenant, sama seperti success tenant. Untuk outlet, aksinya menutup panel.
2. Success outlet: beri aksi yang setara, yaitu menutup panel atau memindahkan fokus ke daftar outlet.
3. Glyph "✓" di judul success: ganti dengan ikon lucide `Check` ber-`aria-hidden`.

## S2 owner (`ws01-platform-tenants/owner-section.tsx`, `owner-state.ts`, `owner-hooks.ts`, `tests/be0lx-owner-ui.test.mjs`; JANGAN edit `tenant-detail-page.tsx`)
Latar: belum ada endpoint daftar Owner atau pencarian akun (kartu backend `legend-co93l`).
1. Field akun: `accounts` selalu kosong dan `resolveAccount` hanya menerima UUID. Bila `accounts` kosong, label, placeholder, dan hint harus jujur, misalnya "ID akun (UUID)" dan "Tempel ID akun dari daftar pengguna. Pencarian nama atau email menyusul." Pertahankan dukungan datalist untuk kasus `accounts` terisi.
2. Bila server menjawab 409 "tenant sudah punya Owner" (cek kode error persisnya di `apps/api` dan `packages/shared/src/platform/errors.ts`, baca saja), tampilkan banner jujur: "Tenant ini sudah punya Owner. Ganti Owner belum bisa dari panel ini sampai daftar Owner tersedia." Jangan tampilkan "Akun ini sudah menjadi Owner aktif". Bedakan dari 409 duplikat akun yang sama bila kodenya berbeda.
3. Banner sukses memakai pola live region persisten (lihat di atas).
4. Loading: tambah `<span className="sr-only">` dengan teks memuat, selain `aria-busy`.
5. "Menyimpan..." diganti "Menyimpan…".

## S3 domain (`ws01-org/components/domain-settings-page.tsx`, `ws01-org/domain-state.ts`, `tests/az8z5-domain-verification-ui.test.mjs`)
1. Tambah link kembali "‹ Pengaturan" ke `/kelola/pengaturan` di atas judul, di semua keadaan. Tiru `PageHead` di `ws07-accounting/components/account-mappings-page.tsx`.
2. Kedua tombol "Salin": tambah `aria-label="Salin nama/host"` dan `aria-label="Salin nilai"`.
3. "Tersalin": pakai live region persisten dan kosongkan setelah sekitar 2 detik.
4. Banner sukses: pakai live region persisten.

## S4 MFA recovery (`ws01-auth/components/{totp-enroll,mfa-panel,recovery-section,recovery-codes-card,recovery-login}.tsx`, `ws01-auth/recovery-state.ts`, `packages/shared/src/i18n/messages/ws01-auth.ts`, `tests/sw980-mfa-recovery-ui.test.mjs`)
1. Kunci dialog enrol sejak `verify.isSuccess` (kode sedang dibuat), bukan baru saat kode tiba. Panggil `onCodesVisibleChange(true)` sejak itu, supaya Esc atau klik luar tidak membuang kode yang hanya tampil sekali.
2. Tombol "Lewati, buat nanti di Keamanan" tidak ada di mockup. Tampilkan HANYA saat pembuatan kode gagal, berdampingan dengan "Coba lagi". Di jalur normal tombol itu tidak ada.
3. Keadaan `saved` sesuai mockup: kartu inline "Kode cadangan disimpan" dengan isi "Kode tidak ditampilkan kembali. Simpan di tempat yang aman untuk digunakan saat diperlukan." (key i18n baru). Toast boleh tetap ada.
4. Keadaan error sesuai mockup:
   - Banner: "Kode cadangan belum dapat dimuat. Periksa koneksi dan coba lagi."
   - Kartu: "Ada masalah saat memuat", dengan isi "Kembali ke pengaturan keamanan atau coba lagi."
   - Pisahkan banner dari kartu.
5. Keadaan loading: tampilkan judul "Memuat kode cadangan…" di atas skeleton.
6. Success di `recovery-login`: copy persis mockup "Kode cadangan diterima. Anda dapat melanjutkan masuk."
   - Hapus baris "Sisa N kode cadangan." di keadaan normal.
   - Pertahankan peringatan `successLow` hanya saat sisa kode sedikit.
   - Hapus hint contoh `recoveryLogin.hint` (ABCDE-12345) bila tidak ada di mockup.
7. `autoFocus` di `recovery-login`: hanya aktif bila `matchMedia("(pointer: fine)")` cocok.
8. Banner sukses di `recovery-codes-card`: pakai live region persisten.

## S5 UOM (`ws06-inventory/components/{units-page,uom-dialog}.tsx`, `ws06-inventory/uom-state.ts`, `tests/legend-7z38l-uom-ui.test.mjs`)
1. Header sesuai mockup: hint halaman "Kelola satuan untuk bahan dan persediaan tenant ini." (`UOM_COPY.hint`) dan tombol "+ Tambah satuan" (`UOM_COPY.add`) di kanan atas header, bukan di dalam kartu. Cek dulu cara shell inventori menerima aksi header. Bila shell bersama harus diubah, jangan ubah; laporkan saja.
2. Kolom Kode: teks polos (font mono boleh), bukan `Badge`.
3. `idempotencyKey`: buat ulang setiap kali body berubah (kode atau nama), bukan satu key untuk seluruh umur dialog.
4. `RESERVED_UOM_CODES`: turunkan dari `STANDARD_UOM_CATALOG` di `@starter/shared` (`packages/shared/src/inventory/standard-uoms.ts`). Pastikan subpath export-nya ada dan test node tetap bisa memuatnya. Bila test node tidak bisa memuat paket shared, pertahankan salinan dan tambah test yang membandingkan salinan itu dengan sumber.
5. Kode satuan saat ubah nama: beri label yang terhubung, berupa `dl`/`dt`/`dd` atau input readonly berlabel.
6. Banner sukses: pakai live region persisten.

## S6 mappings (`ws07-accounting/components/account-mappings-page.tsx`, `ws07-accounting/mapping-state.ts`, `packages/shared/src/i18n/messages/accounting-mapping.ts`, `tests/legend-fzvh-account-mappings-ui.test.mjs`)
1. Saat ganti badan usaha dan draf belum disimpan (`dirty`): tampilkan dialog konfirmasi "Buang perubahan yang belum disimpan?" sebelum `selectEntity`. Tambah `beforeunload` saat dirty.
2. Pindahkan "Kelengkapan pemetaan: N dari M peran dipetakan" ke kartu scope, di samping picker badan usaha, sesuai mockup. Saat loading atau error, tampilkan "–" atau skeleton.
3. Loading: tambah teks `sr-only` memuat.
4. Saat simpan gagal karena validasi (422 issues): pindahkan fokus ke select pertama yang bermasalah.
5. Banner sukses: pakai live region persisten.
