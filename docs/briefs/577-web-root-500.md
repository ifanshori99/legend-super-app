# Brief: engineer (Codex) — web root 500, endpoint tenant/site 404 (legend-uhp28)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`.

## Kartu
`bd show legend-uhp28`. Di worktree berbasis int/batch49: API `/api/health` 200, tetapi halaman web `/` 500 karena endpoint tenant/site mengembalikan 404. Batch49 membawa ws/platform-tenant-be.

## Tujuan
1. Reproduksi di `milestone/m1` (ab574d58) dengan setup lokal standar (`pnpm dev:prepare`, `pnpm run doctor`, `pnpm dev`; port + nama DB sendiri, maks 2 dev server di Mac). Bedakan: regresi kode, atau setup lokal (tenant/site belum di-seed, host tidak terpetakan).
2. Regresi kode: perbaiki akar, test gagal-dulu (API dan/atau web loader). Web tidak boleh 500 saat tenant/site tidak ditemukan: tampilkan halaman 404/"situs tidak ditemukan" yang rapi, bukan crash.
3. Setup lokal: perbaiki seed/doctor supaya worktree baru langsung jalan, dokumentasikan singkat di `docs/local-development.md`.

## Repo
Worktree dari Ghostex basis `milestone/m1`. Cabang `fix/web-root-500`. Commit lokal, push cabang boleh. Tanpa migrasi kecuali terbukti perlu (nomor 0414+).

## Bukti selesai
- Test terarah lulus, typecheck web+api, screenshot `/` sebelum/sesudah (`ghostex visual check`).
- Satu subagent reviewer (tingkat S) mereview diff; bila menyentuh auth/akses tenant: architect high.
- Jangan `pnpm check` penuh, jangan sentuh milestone/m1 atau main, jangan deploy. Matikan dev server setelah selesai.
