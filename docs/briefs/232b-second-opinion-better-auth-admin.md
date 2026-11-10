# Brief: second-opinion — kunci endpoint admin Better Auth dan push dari sesi support (legend-imdzn, legend-8bvin)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/better-auth-admin-lockdown`, cabang `ws/better-auth-admin-lockdown`, SHA `814bc779`.
Rentang diff: `git diff d7a95d0c 814bc779` (basis `integ/m1-batch31`).
Rentang kedua (legend-atwse): worktree `.worktrees/admin-notes-guard`, cabang `ws/admin-notes-guard`, SHA `6b2fedbf`, `git diff 814bc779 6b2fedbf`. Satu run boleh memakai `git diff d7a95d0c 6b2fedbf` dari worktree kedua (berisi kedua rentang).

## Berkas berisiko
- `apps/api/src/lib/auth.ts` (`hooks.before` Better Auth)
- `packages/shared/src/permissions.ts` (statement role `admin`)
- `apps/api/src/middleware/support-session.ts` (`CREDENTIAL_PATHS`)
- `apps/api/src/routes/admin.routes.ts` (`requirePlatformAdmin`, `requireSessionMfa()`), `e2e/helpers.ts`, `e2e/roles.spec.ts`, `apps/api/src/test/admin.test.ts`
- `apps/api/src/test/better-auth-admin-lockdown.test.ts`, `apps/api/src/test/support-session-readonly.test.ts`
- Konteks, tidak berubah: `apps/api/src/middleware/auth.ts` (`requirePermission` memanggil `auth.api.userHasPermission`), `apps/api/src/services/platform-support.service.ts` (`isPlatformAdmin`, `assertImpersonationAllowed`), `node_modules/better-auth` 1.7.7 (`dist/api/dispatch.mjs`, `dist/plugins/admin/routes.mjs`).

## Invariant (PRD)
- TEN-04: admin platform hanya masuk ke data tenant lewat grant support aktif yang disetujui owner, dengan audit sensitif per tenant. Tanpa grant: tidak ada akses baca atau tulis data user tenant.
- Admin platform yang dicabut (`platform_admins.revoked_at` terisi) kehilangan seluruh akses platform pada request berikutnya, meskipun `user.role` masih `admin`.
- Sesi support (impersonate), juga dengan grant `read_write`, tidak boleh membuat atau mengubah kredensial yang bertahan sesudah sesi atau grant berakhir (token, perangkat, PIN, klien MCP, langganan push).
- Keluar dari impersonate tidak pernah diblok.
- Pemeriksaan izin di server (`requirePermission`) tetap bekerja untuk role yang memang punya izin.
- AUTH-05: API admin platform (`/api/platform/*`, `/api/admin/*`) tertutup sampai sesi memverifikasi faktor kedua.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
