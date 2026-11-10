# Second opinion (Codex): access small fixes

Repo worktree `.worktrees/access-small-fixes`, cabang `ws/access-small-fixes` (dari `ws/grant-role-lock-b33` 783e3bbf). Diff: `git diff 783e3bbf..HEAD`. Read-only review. Uang/auth: xhigh.

Periksa dan laporkan cacat nyata (file:line + skenario gagal konkret), atau "tidak ada":

1. `apps/api/src/services/access.service.ts` `updateCustomRole` (legend-tegsk): sekarang `SELECT ... FOR UPDATE` role dulu, lalu `now = new Date()`, lalu `assertTenantPermission`, baru 404. Risiko deadlock dengan kunci advisory per tenant (`legend:role-assignment-end:<tenant>`) di grant/end? Masih ada jalur yang membaca jam lebih awal? `createCustomRole`/`replaceApprovalMatrix` sengaja tidak diubah (risiko rendah).
2. `packages/shared/src/access/{permissions,roles}.ts`, `i18n/messages/access.ts`: `self.loan.request` (employee via SELF_SERVICE), `hr.announcement.manage` (hr, owner, general_manager; bukan kitchen_lead/tenant_admin). Ada invarian template atau seed DB yang perlu migrasi? API/nav pengumuman belum dialihkan dari `hr.sop.manage` (kartu lanjutan dibuat).
3. `apps/api/src/services/platform-theme.service.ts` `createThemeDraft` (legend-iiqx): `logoMediaId` harus ada di `core_storage_objects` tenant yang sama (422), tanpa batas purpose. RLS, TOCTOU, jalur lain yang menulis `logoMediaId` (platform-brand.service.ts) tanpa cek?
4. legend-o0pp dilewati: `returnPathSchema` sudah menolak `\` dan spasi (schemas.ts:136), test di `tests/login-flow.test.mjs:191`.

Test: `apps/api/src/test/access-update-role-lock.test.ts`, `platform-theme-db.test.ts`, `tests/access-contract.test.mjs`.

## Tambahan: cabang `ws/access-perm-backfill` (dari ujung `ws/access-small-fixes`)

Diff: `git diff ws/access-small-fixes..ws/access-perm-backfill`. Read-only. Uang/auth/migrasi: xhigh.

5. `apps/api/drizzle/0171_access_perm_backfill.sql` (legend-9yb5u), `meta/_journal.json` idx 171 `when` 1794250000000, `meta/0171_snapshot.json` (prevId = id snapshot 0163, 8e79b28c; merge train rechain). NO FORCE / FORCE RLS di `roles`, UPDATE idempoten hanya `is_template` + `template_key`: `hr.announcement.manage` -> owner, general_manager, hr; `self.loan.request` -> employee. Bukan tenant_admin, kitchen_lead, role custom. Ada seed/jalur lain yang membuat role template per tenant dan perlu diubah?
6. Guard dialihkan: `hris-announcement.routes.ts` (MANAGE, FEED), `hris-announcement.service.ts` (`ANNOUNCEMENT_MANAGE_CODE`), nav/guard `ws10-learning` dan `/kelola/pengumuman` ke `hr.announcement.manage`; nav + guard `/karyawan/kasbon` ke `self.loan.request`. Akibat: kitchen_lead (tanpa `self.sop.read`) tidak lagi membaca feed pengumuman. Route API `/api/hris/me/loans` belum ada di basis (hanya kontrak di shared), thread payroll harus memakai `self.loan.request`. Ada pemakai `hr.sop.manage` untuk pengumuman yang terlewat?
7. `apps/api/src/services/tenant-media.ts` (`assertTenantMedia`), dipakai `createBrand`/`updateBrand` (`org.service.ts`, legend-ja7i7) dan `createThemeDraft`. Penulis lain `brands.logo_media_id` atau `tenant_themes.logo_media_id` tanpa cek? Penanganan `undefined` vs `null` di `updateBrand`.

Test baru: `access-perm-backfill-migration.test.ts`, `org-brand-logo-media.test.ts`, test 403 di `hris-announcement.test.ts`.
