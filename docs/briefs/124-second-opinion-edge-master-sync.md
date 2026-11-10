# Brief: second-opinion — sinkron master lokasi stok, UOM, dan bagan akun ke edge (legend-9ppw)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-master-sync`, cabang `ws/edge-master-sync`, SHA `3c131bda`.
Base `d82041ee` (`ws/provisioning-default`). Rentang lengkap: `git diff d82041ee ws/edge-master-sync -- . ':!apps/api/src/test'` (sekitar 1.000 baris non-test, dibagi 2 run):

- Run 1 (sekitar 600 baris): `git diff d82041ee ws/edge-master-sync -- apps/api/src/edge/master-sync.ts apps/api/src/edge/bootstrap.ts`
- Run 2 (sekitar 400 baris): `git diff d82041ee ws/edge-master-sync -- packages/shared/src/edge/master-sync.ts packages/shared/package.json apps/api/src/services/edge-master-sync.service.ts apps/api/src/routes/edge-bootstrap.routes.ts`

Test (konteks, bukan target): `apps/api/src/test/edge-master-sync.test.ts`, `apps/api/src/test/edge-bootstrap.test.ts`.

## Berkas berisiko
- `apps/api/src/edge/master-sync.ts`: fetch, verifikasi tanda tangan, apply snapshot di edge, loop berkala.
- `apps/api/src/edge/bootstrap.ts`: boot pertama (bundle + master dalam satu transaksi) dan jalur "present".
- `apps/api/src/services/edge-master-sync.service.ts`: snapshot cloud per kredensial edge.
- `apps/api/src/routes/edge-bootstrap.routes.ts`: `GET /api/edge-sync/bootstrap/masters`.
- `packages/shared/src/edge/master-sync.ts`: kontrak zod snapshot.

## Konteks
- Applier cloud `apps/api/src/edge/stock-moved-applier.ts` dan `inventory.service.ts` `requireLocation` menolak lokasi yang tidak dikenal.
- Provisioning cloud: `services/inventory-provisioning.service.ts`, `services/accounting-provisioning.service.ts`.
- Pola tanda tangan sama dengan bundle bootstrap (`services/edge-bootstrap.service.ts`, `packages/shared/src/edge/bootstrap.ts`).
- Loop berkala belum dipasang di `edge/runtime.ts` (berkas dibekukan); patch ada di `docs/briefs/123-runtime-wiring-edge-master-sync.patch`.

## Invariant
- Id baris di edge identik dengan cloud. Edge tidak pernah membuat id baru untuk master ini dan tidak memindah id ke baris lain.
- Isolasi: edge outlet A hanya menerima lokasi outlet A; bagan akun dan mapping hanya milik badan hukum outlet itu; UOM hanya tenant itu. Tenant dan outlet hanya dari kredensial terverifikasi.
- Boot pertama atomik: bundle dan master tertulis semua atau tidak sama sekali.
- Boot berikut tidak boleh terhalang oleh cloud yang tidak terjangkau (edge harus tetap jalan offline).
- Cloud menang. Lokasi, UOM, dan akun tidak pernah dihapus di edge (dirujuk ledger). Set mapping diganti utuh.
- Galat dan log tidak membawa kredensial atau parameter SQL.

## Effort
xhigh (sinkron offline).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
