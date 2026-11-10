# Brief 130: second opinion Codex, pajak default tenant baru (legend-9obf)

Tingkat K (pajak). Wajib sebelum gerbang rilis. Tidak menahan slice berikut.

## Rentang diff
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/tax-default` (worktree `.worktrees/tax-default`).
- `d82041ee20172f5d3e934b68113db9a8890ee3a1..9a057246ed8c94756095b0ba87be971258e47aeb` (satu commit).
- Non-test sekitar 300 baris, satu run cukup (batas 800).

## Berkas non-test (urut risiko)
1. `apps/api/src/services/tax-provisioning.service.ts` (baru, 268 baris): seed aturan PBJT-FNB dan `tax_settings`, advisory lock per tenant, audit, `backfillTenantTaxDefaults`, `priceReady`.
2. `apps/api/src/services/platform-org.service.ts`: pemanggilan di dalam transaksi `createTenant`.
3. `apps/api/src/db/backfill-tenant-defaults.ts`: langkah backfill pajak per tenant, laporan, exit code.

Berkas test (untuk dibaca, bukan dinilai per baris): `apps/api/src/test/tax-provisioning.test.ts`, dua assertion audit di `platform-org-api.test.ts` dan `platform-admin-provision.test.ts`.

## Konteks keputusan
- Founder Q13 (9 Nov 2026): harga menu eksklusif, pajak dan service ditambahkan di struk.
- Default: PBJT-FNB 10%, tenant-wide, `price_includes_tax=false`, half_up (service, pajak, dasar inklusif), `package_allocation=fixed_bp`, `calculation_order=discount_service_tax`, versi 1, status published.
- Tidak ada aturan service charge dan tidak ada PBJT-FASILITAS di default.

## Invariant yang harus dipegang
1. Dalam transaksi tenant yang sama dengan `createTenant`; gagal berarti tenant ikut batal.
2. Idempoten dan hanya menambah: tenant yang sudah punya baris `tax_rules` (apa pun) tidak diberi aturan; yang sudah punya `tax_settings` tidak diberi settings. Tidak ada UPDATE atau DELETE.
3. `region_code` null: POS dan QR memanggil engine dengan `regionCode: null`, aturan berwilayah tidak akan cocok dan setiap order gagal `TAX_RULE_NOT_FOUND`.
4. Aturan terbit tidak boleh memicu `TAX_RULE_AMBIGUOUS` (dua aturan tenant-wide food_beverage berperingkat sama) pada tenant yang punya aturan dengan kode lain.
5. `published_at` dan `published_by` terisi persis saat status published (CHECK). Tanpa aktor manusia dipakai id sistem `00000000-0000-4000-8000-000000000001` (tanpa FK).
6. `effective_from` tetap `2024-01-01`, bukan tanggal fixture, agar tanggal bisnis lama tidak gagal tertutup.
7. Isolasi tenant: semua baris membawa `tenant_id` konteks, RLS berlaku, backfill satu tenant tidak menyentuh tenant lain.
8. Audit: satu baris per tabel yang diisi (`tax.rules.provisioned`, `tax.settings.provisioned`), nol bila tidak ada yang diisi; field audit hanya kode dan angka, tanpa teks bebas atau PII.
9. Kegagalan backfill pajak satu tenant tidak melewatkan tenant berikutnya, exit code tetap 1.
10. Engine perhitungan pajak, route pajak, `app.ts`, dan UI tidak berubah.

## Yang perlu dinilai
- Kebenaran uang: apakah default ini bisa menghasilkan pajak atau total salah untuk order POS dan QR (eksklusif)?
- Race antara backfill dan penulisan konfigurasi pajak oleh owner (lock hanya dipegang provisioning).
- Apakah ada pembaca `published_by` atau `tax_rules` yang pecah oleh id sistem atau aturan tanpa wilayah.
- Tes yang lulus karena alasan salah.
- Format temuan: `berkas:baris`, tingkat keparahan, skenario gagal konkret.
