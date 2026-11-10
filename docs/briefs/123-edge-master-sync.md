# Brief 123: engineer — kirim lokasi stok, UOM, dan bagan akun ke edge (legend-9ppw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (sinkron offline): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/provisioning-default` (d82041ee, belum di m1; berisi provisioning cloud yang dibutuhkan kartu ini).
`git worktree add .worktrees/edge-master-sync -b ws/edge-master-sync ws/provisioning-default`. Jangan pakai `--worktree` Ghostex.

## Tujuan
Mini PC outlet (edge) menerima master lokasi stok, UOM, dan bagan akun beserta mapping dengan id yang sama seperti di cloud, saat bootstrap dan saat master berubah, sehingga posting stok dari edge diterima applier cloud.

## Kartu
`legend-9ppw`. Di awal: `ghostex board associate legend-9ppw` dan `bd update legend-9ppw --status in_progress`. Saat melapor: `bd update legend-9ppw --status review` dan `bd comment legend-9ppw "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-9ppw`.
- `apps/api/src/edge/bootstrap.ts` (`insertBundle` hanya menyalin tenant/entity/brand/outlet), stream sinkron cloud ke edge, applier stock-moved di cloud.
- Provisioning cloud: `accounting-provisioning.service.ts`, `inventory-provisioning.service.ts` di base branch.

## Scope
- Boleh diubah: `apps/api/src/edge/bootstrap.ts`, modul sync stream master cloud ke edge, `packages/shared` bila kontrak bundle perlu field baru, test di `apps/api/src/test/`.
- Jangan disentuh (sedang diubah penggabungan tahap 3 atau cabang lain): `apps/api/src/app.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/worker-main.ts`, `apps/api/src/edge/runtime.ts`, `packages/shared/src/edge` kecuali file baru, `inventory.service.ts`, limiter edge. Bila perubahan di file ini tidak bisa dihindari, berhenti dan laporkan dulu.
- Jangan tambah migrasi bila bisa dihindari; bila perlu, laporkan nomornya.

## Bukti selesai
- Test: bootstrap edge baru membawa lokasi, UOM, CoA + mapping dengan id identik; perubahan master di cloud sampai ke edge; posting stok dari edge memakai lokasi itu diterima applier cloud; isolasi tenant dan outlet (edge outlet A tidak menerima lokasi outlet B).
- `LEGEND_TEST_FILES="<file test baru dan yang terdampak>" pnpm test` dari root worktree.
- Lint dan typecheck paket yang berubah lewat `heavy`.

## Sebelum melapor
Commit lokal di `ws/edge-master-sync`, hanya file dalam scope. Jangan push. Tulis brief second-opinion Codex di `docs/briefs/124-second-opinion-edge-master-sync.md` (folder proyek, jangan commit): rentang diff non-test maks 800 baris per run, berkas berisiko, invariant. Jangan sebut temuan review Claude.

## Laporan
SHA awal..akhir, migrasi bila ada, hasil gate, temuan review K, file berubah, bead baru, risiko tersisa.
