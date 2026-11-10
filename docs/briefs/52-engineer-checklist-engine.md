# Brief: engineer — mesin checklist operasional (legend-5v69)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/checklist-engine`, cabang `ws/checklist-engine` (dari `main`). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
PRD v1.7 §3 F41 Checklist Operasional (`docs/PRD.md`), WS-14. Template checklist (berversi), penugasan per shift/role, run (E), alert item terlewat/gagal ke supervisor ≤15 menit lewat job scheduler (pg-boss worker yang sudah ada) dan port notifikasi. Keputusan owner: run menyimpan snapshot item template (`checklistRunSchema.items` + `templateVersion`, lewat `snapshotChecklistTemplate(template)`); hasil dicatat terhadap `run.items`, selain itu `CHECKLIST_ITEM_NOT_IN_RUN` 404. Pakai kontrak yang sudah ada di `packages/shared`. Detail: `bd show legend-5v69`.

## Kartu
`legend-5v69`. Di awal: `ghostex board associate legend-5v69`, `bd update legend-5v69 --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan
- Isolasi tenant/outlet dengan RLS FORCE pada tabel baru. Waktu jadwal pakai zona waktu outlet.
- Alert idempoten (satu alert per item per run), tidak spam saat job diulang.
- Migration: drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/operations*.ts`, migration baru, `apps/api/src/services/operations*.ts`, `apps/api/src/routes/operations*.routes.ts`, consumer/job worker untuk checklist, `apps/api/src/test/operations*.test.ts`, satu-dua baris registrasi di `routes/index.ts`/`schema/index.ts`/`worker-main.ts`.
- Jangan: `apps/web/`, POS/payment/KDS/inventory.

## Bukti selesai
- Test: template berversi; run snapshot tidak berubah saat template diubah; item di luar run 404; penugasan per shift/role; alert terlewat/gagal ≤15 menit (waktu dipalsukan), idempoten; isolasi tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir; jangan ulang run basi). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal merujuk `legend-5v69`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
