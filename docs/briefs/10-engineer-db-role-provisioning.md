# Brief: engineer — provisioning role database saat first boot (legend-zoqc)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian kerja berat dan definisi selesai), lalu ikuti. Konvensi repo: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`, `docs/deployment.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5 (di luar repo).

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning`, cabang `ws/db-role-provisioning` (dari `main` terbaru). Jangan pindah cabang.

## Tujuan
Job first-boot yang dijalankan operator di jaringan privat: setelah migrasi, membuat role database terbatas untuk aplikasi dan queue/worker, tanpa pernah memberikan kredensial administrator ke service aplikasi. Didokumentasikan dan dites integrasi. Acuan: PRD v1.7 §3 F3 dan TEN-02 (`docs/PRD.md`).

## Kartu
`legend-zoqc`. Di awal: `ghostex board associate legend-zoqc` dan `bd update legend-zoqc --status in_progress`. Saat melapor: `bd update legend-zoqc --status review` dan `bd comment legend-zoqc "<ringkasan bahasa biasa>"`.

## Catatan
- Area keamanan + migrasi: buat plan singkat dulu, lalu kerjakan. Role aplikasi tidak boleh BYPASSRLS, bukan owner tabel, tidak bisa DDL. Job idempoten (aman dijalankan ulang). Password role dari env/secret file, tidak pernah dicetak ke log.
- Cek migration terakhir di `apps/api/drizzle/`. Bila perlu migration: drizzle-kit, jangan edit `_journal.json` manual, diff SQL hasil generate, buktikan di DB kosong.
- Rahasia: jangan baca `.env*`. Nama key dari `.env.example`.
- Docker: `~/.claude/scripts/colima-up` bila perlu; matikan setelah selesai.

## Scope
- Boleh diubah: script/job provisioning (misal `scripts/`, `deploy/`, atau `apps/api/src/db/`), compose/deploy terkait, `.env.example` (nama key saja), `docs/deployment.md`, test integrasi.
- Jangan disentuh: `apps/web/`, `design/`, layar UI, kontrak `packages/shared/` kecuali benar-benar perlu (sebutkan di laporan).

## Bukti selesai
- Test integrasi: DB kosong → migrate → job → role app bisa baca/tulis sesuai RLS, tidak bisa DDL/BYPASSRLS; job dijalankan dua kali tetap sukses.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer (konteks segar) cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/db-role-provisioning`, pesan merujuk `legend-zoqc`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cara operator menjalankan job (bahasa biasa), risiko tersisa, kebutuhan dari CTO.
