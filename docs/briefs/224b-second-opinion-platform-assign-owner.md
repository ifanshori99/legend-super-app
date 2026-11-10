# Brief 224b: second opinion — platform assign/replace tenant Owner (legend-ktc4d)

Tingkat K (auth). Peran: `second-opinion` Codex, effort high. Read-only review; jangan edit, commit, atau push.

## Rentang diff
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/platform-assign-owner`, cabang `ws/platform-assign-owner`.
- Diff: `git diff e2d5df50..9b9d719e` (satu commit 9b9d719e di `ws/platform-assign-owner`) (base = legend-7vsby, `ws/owner-grant-escalation`).

## Latar
- legend-7vsby: template Owner (`roles.template_key = 'owner'`) hanya bisa diberikan oleh Owner tenant aktif (`packages/shared/src/access/grants.ts` `assertCanGrantRole`). Provisioning tenant hanya membuat `tenant_admin`, jadi tenant baru tidak punya jalan ke Owner pertama.
- Keputusan founder Q44: Super Admin platform boleh menunjuk atau mengganti Owner tenant kapan saja, lewat Panel Platform, dengan MFA dan audit. Sesudahnya Owner menambah Owner lewat jalur tenant biasa.

## Berkas berisiko
- `apps/api/src/services/platform-tenant-owner.service.ts` (baru): seluruh logika tunjuk/ganti.
- `apps/api/src/routes/platform.routes.ts`: dua route baru di bawah `/api/platform/tenants/:tenantId/owners`.
- `apps/api/src/services/platform-admin-provision.service.ts`, `access.service.ts`, `platform-support.service.ts`: helper yang diekspor ulang (resolusi akun undangan, access event, konteks tenant platform).
- `apps/api/src/services/core-audit-writer.ts`: field aman untuk aksi audit baru.
- `packages/shared/src/platform/tenant-owner.ts`, `endpoints.ts`: kontrak input.
- `apps/api/src/test/platform-tenant-owner.test.ts`.

## Invariant yang harus dibuktikan atau dibantah
1. Hanya akun di registry `platform_admins` (Super Admin aktif) yang bisa memakai jalur ini. Admin tenant, custom role, dan pemegang support access tanpa registry ditolak 403.
2. Sesi impersonasi (`session.impersonated_by` terisi) ditolak 403, walau pelakunya Super Admin.
3. Setiap aksi butuh TOTP segar di request (`mfaCode`, umur maksimal sama dengan support access) di atas MFA sesi. Gagal: 403 dan event audit penolakan.
4. Alasan wajib (kosong atau spasi: 422) dan tercatat di audit `role_assignment.granted`/`ended` dan aksi `tenant_owner.*`, bersama pelaku platform, tenant, dan akun.
5. Ganti Owner adalah satu transaksi: Owner baru aktif dan Owner lama berakhir bersama, atau tidak sama sekali. Tenant tidak pernah berakhir tanpa Owner aktif lewat aksi ini, termasuk saat bersamaan dengan "akhiri penugasan Owner" dari sisi tenant (kunci advisory per tenant yang sama dengan `endRoleAssignment`).
6. Super Admin tidak bisa menunjuk dirinya sendiri atau Super Admin lain. Akun sistem dan akun yang di-ban tidak bisa menerima Owner. `{userId}` harus anggota aktif tenant itu; akun lain hanya lewat undangan.
7. Undangan memakai aturan akun yang sama dengan admin pertama provisioning (nomor WhatsApp yang sudah dikenal, email terverifikasi, atau akun baru belum terverifikasi); tidak ada pengambilalihan akun lewat email belum terverifikasi.
8. `assertCanGrantRole` untuk aktor tenant tidak berubah: aturan legend-7vsby tetap berlaku.
9. Tidak ada migrasi, tidak ada perubahan skema event (payload `role_assignment.granted`/`ended` tetap valid).

## Keluaran
Daftar temuan (berkas:baris, skenario gagal konkret, tingkat), atau "tidak ada temuan" per invariant.
