# Fix legend-zoqc putaran 3 (temuan architect, 8 Nov)

Cabang `ws/db-role-provisioning`, worktree `.worktrees/db-role-provisioning`. H1–H3, M1, M2 dinyatakan CLOSED. Dua temuan baru:

## N1 (High): Compose membaca key yang tidak dilihat wrapper
Setelah tanda kutip penutup, Compose membaca sisa baris sebagai pernyataan baru. `defines`, `value_of`, `ascii_keys` di `deploy/single-vm/provision-roles.sh` hanya melihat awal baris. Terbukti dengan Compose 5.6.0:
- `A="x" MIGRATION_DATABASE_URL=<admin>` di api.env: service API menerima `MIGRATION_DATABASE_URL`, wrapper lolos (kutip tunggal sama).
- `NOTE="" APP_DATABASE_URL=<admin>`: Compose memakai URL admin, wrapper memvalidasi URL terbatas. API menolak berkat `apps/api/src/db/role.ts:4-31`.
- Worker tidak punya guard itu (`apps/api/src/worker-main.ts:56`): `X="" WORKER_DATABASE_URL=<admin>` di worker.env menjalankan pg-boss sebagai owner migrasi, audit tetap lolos.

Fix, berurutan:
1. Wrapper memeriksa hasil nyata Compose: `docker compose config --format json` dipipe ke parser yang tidak mencetak apa pun (jq atau node di image job). Tolak bila service api/web/worker punya `MIGRATION_DATABASE_URL`. Wajibkan `APP_DATABASE_URL` dan `WORKER_DATABASE_URL` sama dengan nilai yang dicek wrapper. Jangan pernah mencetak nilainya. Bila tidak bisa: tolak teks apa pun setelah kutip penutup selain komentar, dan tolak nilai berkutip multi-baris untuk kedua jenis kutip.
2. Tambah cek role elevated ala `createAppPool` di koneksi pg-boss worker (`apps/api/src/worker/runtime.ts`).
3. Test regresi di dekat `tests/db-role-provisioning.test.mjs:1511` memakai kasus Compose nyata di atas, termasuk worker.

## N2 (Low)
Nilai berkutip tunggal multi-baris tidak dilacak awk di `provision-roles.sh:49`; dua parser bisa berbeda lagi. Tutup sekalian (biasanya hilang bila fix 1 memakai `docker compose config`).

## Bukti selesai
Tiap fix punya test yang gagal bila fix dicabut. Gate penuh (`heavy pnpm check`, `heavy pnpm build`, `heavy pnpm test:setup`, `pnpm format:check`, `color.mjs`, `tenant-hardcode.mjs`), `git status` bersih, commit lokal merujuk legend-zoqc. Reviewer konteks segar cek diff. Jangan push/merge.
