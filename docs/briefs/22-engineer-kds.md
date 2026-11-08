# Brief: engineer — KDS routing dan siklus tiket (legend-4d5)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/kds`, cabang `ws/kds` (dari `main`). Jangan pindah cabang.

## Tujuan
Backend Kitchen Display: tiket dari order POS dirutekan ke stasiun dapur sesuai pemetaan menu, siklus status tiket (state machine) dengan timestamp tiap transisi dan audit, dikirim lewat WebSocket edge ≤2 detik, resync berbasis sequence saat reconnect tanpa hilang/duplikat. Acuan: PRD v1.7 §3 F12, KDS-01..04 (`docs/PRD.md`). Detail kartu: `bd show legend-4d5` (termasuk catatan helper otorisasi stasiun dari legend-fsb7: `requireStationPermission`, `assertStationPermission`, `permittedStationIds`; stasiun tidak dikenal = tolak).

## Kartu
`legend-4d5`. Di awal: `ghostex board associate legend-4d5` dan `bd update legend-4d5 --status in_progress`. Saat melapor: `bd update legend-4d5 --status review` dan `bd comment legend-4d5 "<ringkasan bahasa biasa>"`.

## Catatan
- Cabang lain sedang memakai nomor migration 0063–0065 (pos-shift, pos-payment-fixes). Generate dengan drizzle-kit seperti biasa; nomor dirapikan saat merge. Jangan edit `_journal.json` manual.
- Tiap tabel tenant: `tenant_id NOT NULL`, RLS enforced (ENABLE + FORCE + policy `tenant_id = app.require_tenant_id()`), unique constraint menyertakan `tenant_id`, tabel operasional punya `outlet_id`.
- Rahasia: jangan baca `.env*`. Docker: `~/.claude/scripts/colima-up` bila perlu.

## Scope
- Boleh: `apps/api/src/db/schema/kds*.ts` / `pos*.ts`, `apps/api/drizzle/<migration baru>`, `apps/api/src/services/kds*.ts` / `pos*.ts` seperlunya, `apps/api/src/routes/kds*.routes.ts`, test `apps/api/src/test/kds*.test.ts`, kontrak `packages/shared` untuk KDS.
- Jangan: `apps/web/`, `design/`, file pos-shift/pos-receipt/pos-payment (cabang lain).

## Bukti selesai
- Test integrasi KDS-01..04, termasuk isolasi lintas tenant/outlet/stasiun, reconnect tanpa hilang/duplikat, dan transisi status ilegal ditolak.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/kds`, pesan merujuk `legend-4d5`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, migration, risiko tersisa, kebutuhan dari CTO.
