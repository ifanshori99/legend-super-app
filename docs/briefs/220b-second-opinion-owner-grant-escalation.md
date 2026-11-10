# Brief: second-opinion — Owner template hanya dari Owner (legend-7vsby)

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Hanya membaca dan melapor; jangan mengedit, commit, push, atau merge.

## Repo dan diff
Repo `/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/owner-grant-escalation` (basis `ws/receipt-writeoff-hardening` c4c347ef). Worktree `.worktrees/owner-grant-escalation`. Commit e2d5df50. Diff: `git diff c4c347ef..ws/owner-grant-escalation`.

## Konteks
Tingkat K (auth). Bug: `packages/shared/src/access/grants.ts` `assertCanGrantRole` melewati otoritas puncak untuk target template owner, tetapi pemberi yang memegang semua izin Owner (misal lewat custom role) tetap boleh memberi Owner. Rantai: admin tenant membuat custom role C berisi semua kode Owner, memberi C ke B, lalu B memberi template owner ke A. Ini menembus batas owner-only write-off (`pos.receipt.writeoff`, legend-l56xd) dan cek `templateKey === "owner"` lain. Keputusan founder Q41 (admin tenant boleh mengatur semuanya) tidak mencakup membuat Owner baru.

Perbaikan:
- `assertCanGrantRole`: target `templateKey === "owner"` mewajibkan pemberi memegang penugasan template owner yang aktif, cakupan tenant, tenant dan user sendiri (`ownerTemplateAssignment`), lalu tetap memegang semua izin yang didelegasikan. Gagal: 403 `PERMISSION_DENIED`.
- `OWNER_TEMPLATE_ONLY_PERMISSIONS = ["pos.receipt.writeoff"]`. `normalizeCustomRolePermissions` menolaknya dengan 422 `PERMISSION_OWNER_ONLY` (kode error baru di `errors.ts` dan katalog i18n).
- Data lama: `rolePermissionsAsGranted` membuang kode itu dari semua role selain template owner saat dibaca (`toRole`, `toRoleGrant`, jalur grant di `access.service.ts`). Edit custom role lama membuangnya dari baris tersimpan (tercatat sebagai removed di event dan audit).

## Pertanyaan
1. Masih adakah jalan bagi non-Owner (admin tenant, custom role, rantai banyak akun, Owner cakupan brand, platform atau support) untuk mendapat template owner atau efek khusus Owner?
2. Apakah pembuangan saat baca untuk data lama aman dan lengkap? Adakah pembaca lain atas `roles.permissions` (misal query `@>` di `apps/api/src/worker/notification-adapters.ts`) yang masih memperlakukan kode itu sebagai dimiliki?
3. Adakah regresi bagi Owner asli, atau bagi pemberian peran lain?

## Laporan
Temuan nyata saja, dengan file:line, tingkat keparahan, dan skenario gagal. Tidak ada temuan: katakan begitu.
