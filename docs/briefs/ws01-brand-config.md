# WS-01 brand + tenant config (cabang ws/brand-config)

Basis: e623ce0b1 (kontrak impor config + izin `org.config.import`). Worktree ini. Jangan merge ke m1, jangan deploy.
Migrasi hanya 0492-0493 bila perlu; `pnpm db:generate` harus kosong sesudahnya. Jangan ubah migrasi yang sudah ada.

## Kartu (`bd show <id>`)
1. legend-bkdmc: rute pasang logo/tema brand dari upload `brand_logo` (isi `brands.logo_media_id`, `tenant_themes.logo_media_id`), izin `org.theme.manage` skala tenant. Ref: branch ws/brand-logo-upload 52f4242a (`git log --all --grep legend-a30j`). UI di luar mockup yang disetujui: lewati, lapor.
2. legend-9k0a5: codec `wifi_policies` di `packages/shared/src/<domain>/config-codec.ts`, daftar di `packages/shared/src/platform/config-codecs.ts` CONFIG_SECTION_CODECS, test di `tests/platform-config-codecs.test.mjs`. Pola: legend-tct8 (`git log --all --grep legend-tct8`). Tanpa rahasia (password Wi-Fi), tanpa id, ref by key.
3. legend-datb2: exporter/importer bundle config. Impor memakai izin `org.config.import` (lihat e623ce0b1, 0c3141c4f); section sensitif tetap diblokir. Satu transaksi, id baru, urutan: roles, approval_policies, CoA parents-first per legal entity.
4. legend-tj8o (tingkat K, review architect xhigh): FE RBAC admin: picker izin custom role hanya menawarkan izin yang boleh ditambah editor (izin yang dipegang, atau semua izin tenant bila Owner/Admin Tenant re-auth), tampilkan SELF_ELEVATION_FORBIDDEN; hanya Owner aktif boleh mengakhiri assignment Owner lain; tombol End nonaktif + penjelasan untuk Owner aktif terakhir (API: CONFLICT 409). Lokasi: apps/web/src/features/ws01-access/.

## Test gagal-dulu wajib
Tenant lain ditolak; tanpa izin 403; admin tidak bisa memberi izin melebihi miliknya.

## Aturan
- Test terarah: `LEGEND_TEST_FILES="..." heavy pnpm test`. Satu token heavy: hanya satu subagent menjalankan tsc/vitest/build.
- Sebelum lapor: `pnpm exec eslint <file>` + `pnpm exec prettier --check <file>` pada file berubah.
- Commit lokal; pesan merujuk ID kartu.
