# Catatan merge train batch62: perbaikan migrasi edge RLS

Sumber: review architect xhigh (14 Nov) atas `fix/edge-migration-rls` 46698834a. Tidak ada cacat pemblokir; perbaikan benar terhadap m1.

Urutan merge:
1. Gabungkan `fix/edge-migration-rls` ke `ws/finance-exceptions` / `ws/payroll-payout-so-fixes` (penerima).
2. `int/batch61` mendarat ke `milestone/m1` dulu.
3. Saat cabang payroll masuk setelahnya: pertahankan 0348 dan 0349 dari batch61 (setara 0534/0536, commit f7c341ab9 + 191163780); hapus file 0534 dan 0536 beserta entri journal-nya. Bila keduanya tertinggal di journal (`when` sama 1794586000000), DB baru menjalankan dua-duanya dan gagal pada CREATE TABLE `payroll_payout_gl_postings` ganda.
4. Nomori ulang 0542, 0543, 0538, 0539, 0546 ke 0350-0354 (idx 350-354, `when` tetap). Pertahankan FK inline 0538/0539 dan perubahan test.
5. Jalankan ulang `node ~/.agents/team/check-journal.mjs origin/milestone/m1` dan test migrasi owner non-superuser.

Kecil (opsional): `edge-received-events-migration.test.ts` ~255-263 belum memeriksa dua FK tenant (`edge_link_dead_letters_tenant_id_tenants_id_fk`, `edge_receipt_skips_tenant_id_tenants_id_fk`).
