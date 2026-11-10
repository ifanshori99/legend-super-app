# Brief: engineer — framework agent EDC di edge (legend-apt)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edc-framework`, cabang `ws/edc-framework` (dari `main`). Jangan pindah cabang.

## Tujuan
Runtime EDC di mode edge: antarmuka `EdcProvider` (request bayar, cancel, status inquiry), registry provider per bank, dan simulator ECR untuk test dan dev. Ini fondasi untuk legend-m0k (orkestrasi bayar EDC di POS). Acuan: PRD v1.7 §3 F13, §4 Alur W (`docs/PRD.md`). Detail: `bd show legend-apt`, `bd show legend-m0k` (konteks pemakai).

## Kartu
`legend-apt`. Di awal: `ghostex board associate legend-apt` dan `bd update legend-apt --status in_progress`. Saat melapor: `bd update legend-apt --status review` dan `bd comment legend-apt "<ringkasan bahasa biasa>"`.

## Catatan
- Area uang: plan singkat dulu. Nominal integer IDR, tidak pernah float. Status inquiry wajib sebelum retry (jangan pernah dobel tagih). Timeout dan koneksi putus menghasilkan status "unknown" yang harus di-inquiry, bukan "gagal".
- Bila perlu tabel: tenant_id NOT NULL, RLS enforced, outlet_id. Cabang lain memakai migration 0063–0065; nomor dirapikan saat merge.
- Rahasia: jangan baca `.env*`. Kredensial bank tidak masuk repo.

## Scope
- Boleh: modul edge EDC baru (misal `apps/api/src/edge/edc/` atau `apps/api/src/services/edc*.ts`), schema/migration EDC, test `apps/api/src/test/edc*.test.ts`, kontrak `packages/shared` untuk EDC.
- Jangan: `apps/web/`, `design/`, service POS order/payment yang sedang dikerjakan cabang lain.

## Bukti selesai
- Test: simulator ECR untuk approve, decline, timeout, cancel, inquiry setelah timeout (tidak dobel), provider tidak dikenal ditolak.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/edc-framework`, pesan merujuk `legend-apt`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa, kebutuhan dari CTO.
