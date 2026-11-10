# Brief: second-opinion (Codex) — small contracts pack

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Read-only. Jangan commit, push, merge.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend/.worktrees/small-contracts-pack`, cabang `ws/small-contracts-pack`, basis `milestone/m1` (94d769c6, setelah rebase). Diff: `git diff milestone/m1...ws/small-contracts-pack`.

## Yang diperiksa (tingkat K: izin dan konkurensi)
1. legend-kz1m — kode izin `org.notification_policy.manage` di `packages/shared/src/access/permissions.ts`, template `owner` (otomatis lewat tag) dan `tenant_admin` (eksplisit) di `roles.ts`, migrasi data `apps/api/drizzle/0159_notification_policy_permission.sql` (journal idx 155, when 1794238000000; pola 0148: NO FORCE RLS, UPDATE idempoten untuk role template, FORCE RLS). Cek: eskalasi hak (siapa bisa memberi izin ini ke peran lain, `assertCanGrantRole`), MFA, peran kustom tidak tersentuh, migrasi idempoten dan aman pada tenant tanpa role template, nomor 0159 (0155-0158 dipesan cabang lain).
2. legend-63l6 — `expectedVersion` opsional di body mutasi order POS (`packages/shared/src/pos/endpoints.ts`) + `If-Match` di `apps/api/src/routes/pos-order.routes.ts`. Keputusan: body ?? header; keduanya ada dan berbeda → 412 `PRECONDITION_FAILED`; keduanya absen → tanpa cek (klien lama). Cek: cek versi di bawah row lock, semua endpoint mutasi tercakup, salinan `expectedVersion` di body dibuang di route sebelum fingerprint idempotency, ETag diambil dari `version` respons, idempotency replay (request dengan idempotencyKey yang sama setelah versi naik tidak boleh jadi 412 palsu atau lolos ganda), respons memuat `version`.
3. legend-lvx2 — empat payload event di `packages/shared/src/operations/events.ts` (kontrak saja, belum ada emitter).

## Laporan
Temuan nyata saja, dengan file:baris, skenario gagal, dan saran perbaikan. Tanpa temuan: katakan itu.
