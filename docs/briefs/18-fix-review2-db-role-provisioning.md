# Brief: engineer — fix temuan second-opinion putaran 2 (legend-zoqc)

Worktree/cabang sama (`.worktrees/db-role-provisioning`, `ws/db-role-provisioning`, HEAD `603099b`). Semua 7 temuan putaran 1 terverifikasi tertutup. Temuan baru di bawah.

## Arah dari CTO (batas ancaman)
Jangan mengejar audit katalog tanpa ujung. Kerjakan secukupnya dan sederhana:
- H1: denylist eksplisit objek sensitif yang tidak boleh terjangkau login app/worker lewat jalur mana pun termasuk PUBLIC (minimal `pg_authid`, `pg_shadow`, `pg_user_mapping`, fungsi file/server `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`, `lo_import`, `lo_export`, `dblink*` bila ada). Bandingkan juga hak PUBLIC katalog dengan baseline bawaan PG yang di-hardcode per versi mayor bila murah; kalau tidak murah, denylist cukup dan catat di docs.
- H2: tolak BOM/NBSP/karakter non-ASCII sebelum key di env file (atau normalisasi lalu validasi). Regresi dengan Compose nyata.
- H3: audit bahwa setiap tabel tenant (yang punya `tenant_id` / terdaftar di `app.enforce_tenant_rls`) punya `relrowsecurity` dan `relforcerowsecurity` true. Ini inti TEN-02, wajib.
- M1: audit sequence (USAGE/SELECT/UPDATE) dan default ACL tipe `S` sesuai peran.
- M2: perbaiki prosedur ganti login queue di docs (rename role yang mempertahankan OID), regresi bila murah.
Tiap fix: test regresi yang gagal saat fix dicabut.

## Bukti selesai
Sama dengan brief 10/12. Lapor singkat: tabel temuan → fix/test. Commit merujuk `legend-zoqc`.

---

## Temuan second-opinion putaran 2
⚠️ **Temuan baru — masih ada blocker:**
- **Tinggi — `apps/api/src/db/provision-roles.ts:329,398`:** Audit memakai hak PUBLIC saat ini sebagai baseline aman. Reproduksi `GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC` tetap meluluskan provisioning dan audit; worker berhasil membaca verifier password. `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC` juga lolos, lalu worker berhasil membaca file server. **Fix:** Bandingkan dengan baseline bawaan yang tepercaya atau tolak akses sensitif secara eksplisit, termasuk grant PUBLIC; tambahkan kedua regresi.

- **Tinggi — `deploy/single-vm/provision-roles.sh:40`:** Parser `defines()` melewatkan BOM UTF-8 dan NBSP sebelum key, sedangkan Compose menerimanya. Dengan `BOM + MIGRATION_DATABASE_URL=<admin>` di baris pertama `api.env`, wrapper dry-run sukses dan konfigurasi Compose nyata memasukkan URL admin ke service API. NBSP memberikan hasil sama. **Fix:** Periksa konfigurasi efektif menggunakan parser Compose secara aman, atau tolak/normalisasi bentuk tersebut sebelum validasi.

- **Tinggi — `apps/api/src/db/provision-roles.ts:630`:** Audit pascamigrasi tidak memeriksa status RLS tabel tenant. Setelah `ALTER TABLE review_tenant DISABLE ROW LEVEL SECURITY`, provisioning dan audit tetap sukses; aplikasi tanpa konteks membaca kedua tenant. **Fix:** Tambahkan pemeriksaan RLS tabel tenant, atau gerbang migrasi terpisah yang benar-benar membuktikan TEN-02 sebelum service dimulai.

- **Sedang — `apps/api/src/db/provision-roles.ts:389,464`:** Sequence dan default ACL sequence tidak diperiksa. Grant UPDATE pada `public.consents_seq_seq` kepada worker lolos; worker berhasil menjalankan `setval(...,9223372036854775807)` sehingga pengambilan nomor berikutnya gagal. Default UPDATE untuk sequence baru juga terbukti lolos. **Fix:** Audit USAGE/SELECT/UPDATE sequence serta default ACL tipe `S`, dengan batas sesuai peran.

- **Sedang — `docs/deployment.md:460`:** Prosedur pergantian login queue tidak lengkap. Job menggulung balik pembuatan login baru saat owner schema berbeda, sehingga instruksi ALTER SCHEMA gagal karena login belum ada. Setelah login dibuat manual dan schema dipindahkan, audit sukses tetapi worker baru tetap gagal membaca tabel queue milik login lama. **Fix:** Dokumentasikan rename role yang mempertahankan OID, atau pemindahan seluruh objek pg-boss ketika menggunakan role baru; tambahkan regresi queue berisi tabel.
