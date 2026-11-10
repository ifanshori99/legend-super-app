# Brief 224c: second opinion — endRoleAssignment lock and permanent Owner (legend-qr1uv)

Tingkat K (auth). Peran: `second-opinion` Codex, effort high. Read-only review; jangan edit, commit, atau push.

## Rentang diff
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/end-role-assignment-lock`, cabang `ws/end-role-assignment-lock`.
- Diff: `git diff 9b9d719e..61eb1ca0` (satu commit 61eb1ca0 di `ws/end-role-assignment-lock`) (base = legend-ktc4d, `ws/platform-assign-owner`).

## Latar
- `apps/api/src/services/access.service.ts` `endRoleAssignment` mengakhiri penugasan role tenant. Untuk penugasan template Owner, `assertCanEndOwnerAssignment` mewajibkan pelaku Owner aktif dan tenant tetap punya Owner lain.
- Semua "akhiri penugasan" di satu tenant diserialkan oleh kunci advisory per tenant (`legend:role-assignment-end:<tenantId>`). Jalur platform legend-ktc4d (`platform-tenant-owner.service.ts`) memakai kunci yang sama dan hanya menghitung Owner permanen (`valid_until` null).
- Perubahan: waktu "sekarang" dibaca sesudah kunci, dan hanya Owner permanen yang dihitung sebagai Owner tersisa.

## Berkas berisiko
- `apps/api/src/services/access.service.ts` (`endRoleAssignment`, `assertCanEndOwnerAssignment`).
- `apps/api/src/test/access-end-owner-lock.test.ts` (baru) dan test akses lama yang memanggil `endRoleAssignment`.

## Invariant yang harus dibuktikan atau dibantah
1. Dua aktor (dua Owner, atau Owner dan jalur platform) yang bersamaan mengakhiri penugasan Owner tidak pernah membuat tenant tanpa Owner aktif, apa pun urutan mereka mendapat kunci.
2. Waktu yang dipakai untuk memeriksa Owner aktif dan untuk menulis `valid_until` tidak lebih awal dari commit pemegang kunci sebelumnya.
3. Owner sementara (`valid_until` di masa depan) tidak dihitung sebagai Owner tersisa, jadi tenant tidak kehilangan semua Owner saat Owner sementara kedaluwarsa. Owner sementara yang masih aktif tetap berwenang sebagai pelaku.
4. Aturan lain tidak berubah: hanya Owner yang boleh mengakhiri Owner lain, "akhiri" hanya memendekkan, non-Owner tidak terpengaruh, kunci diambil sebelum kunci baris (tanpa deadlock).
5. Tidak ada migrasi dan tidak ada perubahan kontrak API atau event.

## Keluaran
Daftar temuan (berkas:baris, skenario gagal konkret, tingkat), atau "tidak ada temuan" per invariant.
