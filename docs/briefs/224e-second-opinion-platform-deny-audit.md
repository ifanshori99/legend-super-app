# Brief 224e: second opinion — platform.access.denied untuk sesi impersonate (legend-ktc4d lanjutan)

Tingkat K (auth, audit). Peran: `second-opinion` Codex, effort high. Read-only review; jangan edit, commit, atau push.

## Rentang diff
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/grant-role-lock-b33`, cabang `ws/grant-role-lock-b33`.
- Diff: `git diff 64c65947..783e3bbf` (basis = `hold/ktc4d-qr1uv-b33` + cherry-pick legend-8ajy4).

## Latar
- Sesudah 6618970d (support read-only), guard support di dalam `requireAuth` menolak sesi impersonate sebelum `requirePlatformAdmin` dan service ktc4d, jadi `tenant_owner.denied` tidak tertulis.
- Perubahan: `requirePlatformAuth` membungkus `requireAuth` di router platform; bersama `requirePlatformAdmin` menulis `platform.access.denied` untuk tiap tolakan 403 karena impersonate. `support-session.ts` dan `lib/auth.ts` tidak berubah.

## Berkas berisiko
- `apps/api/src/middleware/platform-admin.ts`, `apps/api/src/services/platform-access-audit.service.ts`, `apps/api/src/routes/platform.routes.ts`, `apps/api/src/routes/platform-integrations.routes.ts`, `apps/api/src/services/core-audit-writer.ts`.
- Test: `apps/api/src/test/platform-access-denied.test.ts`, `apps/api/src/test/platform-tenant-owner.test.ts`.

## Invariant yang harus dibuktikan atau dibantah
1. Hasil auth tidak berubah untuk semua rute platform: status dan kode error sama seperti sebelum diff; `next()` tidak pernah dipanggil dua kali.
2. Gagal tulis audit tidak mengubah 403 menjadi 500.
3. Pemanggil tidak bisa menulis baris ke log audit tenant yang tidak terkait dengan dirinya (tenant hanya dari `/api/platform/tenants/<uuid>` atau tenant yang di-resolve, dan hanya bila ada role atau grant support).
4. Tidak ada teks bebas atau rahasia di baris audit atau log (route dinormalisasi, segmen bebas jadi `*`, maks 256).
5. Banjir baris dibatasi (satu per sesi, tenant, kode, metode per 60 detik).
6. Tidak ada migrasi dan tidak ada perubahan kontrak API.

## Keluaran
Daftar temuan (berkas:baris, skenario gagal konkret, tingkat), atau "tidak ada temuan" per invariant.
