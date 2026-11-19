# 1189 temuan architect (dibetulkan)

Worktree cabang ws/1189-sealed-reseal-frozen, cwd apps/api. Konteks: docs/briefs/sub-1189-sealed-reseal-frozen.md.

## M1 (sudah diubah CTO di SQL: drizzle/0720_sealed_reseal_frozen.sql dan src/db/schema/sealed-reseal-frozen.custom.sql)
Fungsi kini menolak p_new yang: bukan base64 lengkap (`^[A-Za-z0-9+/]+={0,2}$`, panjang kelipatan 4, maks 8192), kurang dari 29 byte terdecode, atau panjang byte terdecodenya beda dari p_expected, atau byte versi lebih rendah. Semua dengan ERRCODE 22023.

## Tugas implementer (satu orang)
1. Tambah test di `src/test/sealed-secret-reseal-frozen.test.ts` (gaya test (b) yang ada, via SET ROLE legend_sealed_reseal): sampah base64 pendek (<29 byte) ditolak; p_new dengan panjang beda dari p_expected ditolak walau versi naik; base64 tidak lengkap/berisi karakter lain ditolak; reseal sah (panjang sama, versi naik) tetap lolos. Baris tetap tak berubah setelah penolakan.
2. L1 di `src/db/provision-roles.ts` (`assertSealedResealRoleReachedOnly` ~:1072-1100): periksa juga grup `legend_sealed_reseal` sendiri: tanpa hak tabel/sequence apa pun (information_schema/has_table_privilege dengan nama grup), tanpa EXECUTE selain `app.reseal_frozen_sealed(text, text, uuid, uuid, text, text)`, USAGE schema app boleh; fungsi itu SECURITY DEFINER (`prosecdef`), `proconfig` memuat search_path pg_catalog; keanggotaan legend_app tidak punya ADMIN. Tambah kasus di `src/db/provision-roles-audit.test.ts` (grup diberi hak tabel -> audit gagal).
Jalankan: `LEGEND_TEST_FILES="src/test/sealed-secret-reseal-frozen.test.ts src/db/provision-roles-audit.test.ts" heavy pnpm test` dari root worktree (latar, tunggu satu notifikasi), prettier + eslint file yang diubah. Jangan menyentuh berkas lain, jangan commit.
