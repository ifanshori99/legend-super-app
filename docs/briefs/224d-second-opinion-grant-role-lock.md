# Brief 224d: second opinion — grantRoleAssignment tenant lock (legend-8ajy4)

Tingkat K (auth). Peran: `second-opinion` Codex, effort high. Read-only review; jangan edit, commit, atau push.

## Rentang diff
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/grant-role-lock`, cabang `ws/grant-role-lock`.
- Diff: `git diff 61eb1ca0..82778a8a` (base = legend-qr1uv, `ws/end-role-assignment-lock`; commit legend-8ajy4 82778a8a).

## Latar
- `apps/api/src/services/access.service.ts`: `endRoleAssignment` dan jalur platform `platform-tenant-owner.service.ts` sudah mengambil kunci advisory per tenant (`legend:role-assignment-end:<tenantId>`) lalu membaca waktu sesudahnya.
- `grantRoleAssignment` sebelumnya tidak mengambil kunci itu dan membaca waktu sebelum transaksi. Perubahan: kunci yang sama diambil pertama di transaksi, waktu dibaca sesudahnya, lalu pemberi diperiksa (`assertCanGrantRole`, legend-7vsby) dengan data yang dibaca sesudah kunci.

## Berkas berisiko
- `apps/api/src/services/access.service.ts` (`grantRoleAssignment`).
- `apps/api/src/routes/access.routes.ts` (pemanggil, tidak berubah).
- `apps/api/src/test/access-grant-role-lock.test.ts` (baru).

## Invariant yang harus dibuktikan atau dibantah
1. Pemberi yang penugasannya diakhiri pemanggil lain (selesai commit sebelum pemberian ini mendapat kunci) tidak bisa memberi role apa pun, termasuk Owner.
2. Waktu yang dipakai untuk cek re-auth, cek pemberi, dan `valid_from` default tidak lebih awal dari commit pemegang kunci sebelumnya.
3. Urutan kunci sama di semua jalur (kunci advisory dulu, baru kunci baris), jadi tidak ada deadlock baru antara pemberian, pengakhiran, dan jalur platform.
4. Aturan pemberian lain tidak berubah: tanpa self-elevation, re-auth 5 menit, Owner hanya dari Owner, akun sistem atau di-ban ditolak.
5. Tidak ada migrasi dan tidak ada perubahan kontrak API atau event.

## Keluaran
Daftar temuan (berkas:baris, skenario gagal konkret, tingkat), atau "tidak ada temuan" per invariant.
