# Brief 122: second opinion untuk provisioning default CoA, UOM, dan lokasi stok (legend-a7x7)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.
- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran.

## Repo
- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/provisioning-default`, cabang `ws/provisioning-default`, HEAD `d82041ee`.
- Diff: `git diff 0f7e4ff6..d82041ee`. Abaikan `docs/`.
- Ukuran: sekitar 630 baris non-test, jadi cukup satu run (batas 800 baris non-test per run). Test di `apps/api/src/test/provisioning-defaults.test.ts` (sekitar 1.000 baris) dibaca hanya untuk fokus 6.
- Tanpa migrasi baru.

## Berkas berisiko
- `apps/api/src/services/accounting-provisioning.service.ts`: menyalin bagan akun dan mapping, lalu backfill per tenant. Uang dijurnal ke akun yang dipetakan di sini.
- `apps/api/src/services/inventory-provisioning.service.ts`: katalog UOM, enam lokasi stok per outlet, dan backfill.
- `apps/api/src/services/org.service.ts` (`createLegalEntity`, `createOutlet`) dan `apps/api/src/services/platform-org.service.ts` (`createTenant`): memanggil provisioning di transaksi pembuatan.
- `apps/api/src/db/backfill-tenant-defaults.ts`: skrip `pnpm db:backfill-defaults [--tenant <uuid>]` lintas tenant.
- `packages/shared/src/inventory/standard-uoms.ts`.
- Kontrak acuan:
  - `packages/shared/src/accounting/coa.ts`: `standardFnbChartTemplate`, `POSTING_ACCOUNT_ROLES`, `chartOfAccountsIssues`, `accountMappingIssues`.
  - `apps/api/src/db/schema/accounting.ts`, `apps/api/src/db/schema/inventory.ts`.
  - `apps/api/src/services/accounting-accounts.service.ts`, `apps/api/src/services/inventory-setup.service.ts`.

## Fokus (tingkat K: mapping akun menentukan ke mana uang dijurnal)
Invariant yang harus berlaku menurut PRD v1.7 §3.19 Chart of Accounts, §6 F chart_of_accounts dan account_mappings, §16 Lokasi Stok, serta kontrak akuntansi:
1. CoA per entitas legal:
   - Tiap entitas legal punya bagan sendiri, dari `standardFnbChartTemplate`.
   - Parent berada di entitas yang sama, dengan tipe yang sama.
   - Kode akun unik per entitas.
   - Tenant tetap bisa mengubah bagan setelah provisioning.
2. Mapping lengkap:
   - Ke-39 posting role di `POSTING_ACCOUNT_ROLES` dipetakan ke akun yang bisa diposting, dengan tipe yang cocok, di entitas yang sama.
   - Tidak ada role yang hilang atau salah arah, sehingga jurnal otomatis tidak jatuh ke akun keliru.
   - Nilai juga default yang dipilih (mis. `service_charge`).
3. Idempoten:
   - Pemanggilan ulang, backfill berulang, dan dua pemanggilan bersamaan tidak menggandakan akun, mapping, UOM, atau lokasi.
   - Audit hanya tercatat saat ada baris yang disisipkan.
   - Periksa kunci advisory dan urutan kunci terhadap deadlock.
4. Atomik:
   - Provisioning berjalan di transaksi yang sama dengan pembuatan entitas, outlet, atau tenant.
   - Bila provisioning gagal, pembuatan ikut batal.
   - Kegagalan provisioning tidak boleh dilaporkan sebagai error lain (mis. NPWP atau kode outlet duplikat).
5. Isolasi tenant:
   - Provisioning dan backfill tenant A tidak membaca atau menulis baris tenant B.
   - Periksa scope `withTenant` dan RLS, peran database yang dipakai skrip backfill, serta context yang dibangun untuk backfill.
6. Backfill tidak mengubah baris yang ada:
   - Akun, mapping, UOM, dan lokasi lama tidak di-update atau dihapus.
   - Bagan tenant yang sudah ada tidak dicampur dengan template.
   - Nilai kasus entitas lama yang bagannya sebagian, dan outlet lama dengan lokasi custom.
7. Test benar-benar membuktikan klaimnya. Boleh reproduksi dengan `LEGEND_TEST_FILES="src/test/provisioning-defaults.test.ts" pnpm test` dari root worktree.

## Laporan
Temuan diurutkan dari yang paling berat. Tiap temuan: file:baris, masalah, skenario gagal konkret, fix. Tulis "Tidak ada blocker" bila memang tidak ada.
