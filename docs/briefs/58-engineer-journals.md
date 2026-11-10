# Brief: engineer — jurnal manual dan berulang (legend-vmyg)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/journals`, cabang `ws/journals` (dari `main`). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
WS-07, PRD v1.7 §3 F19 Jurnal Manual & Berulang (`docs/PRD.md`): jurnal manual (debit = kredit, integer IDR), template jurnal berulang dengan scheduler job, persetujuan lewat `approval_requests` (pembuat tidak boleh menyetujui) sebelum posting ke ledger append-only. Detail: `bd show legend-vmyg`.

## Kartu
`legend-vmyg`. Di awal: `ghostex board associate legend-vmyg`, `bd update legend-vmyg --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (uang)
- Posting idempoten; jadwal berulang tidak menggandakan jurnal saat job jalan ulang atau dobel (kunci unik per template + periode).
- Cabang `ws/fiscal-close-lock` (belum merge) menambah kunci periode. Sediakan satu titik cek periode (fungsi) yang nanti disambung ke kunci itu saat merge; jangan salin kode cabang itu.
- Tabel baru: `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`. Migration via drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/accounting-journal*.ts`, migration baru, `apps/api/src/services/accounting-journal*.ts`, `apps/api/src/routes/accounting-journal*.routes.ts`, `apps/api/src/test/accounting-journal*.test.ts`, kontrak di `packages/shared`, satu-dua baris registrasi (route, job).
- Jangan: `apps/web/`, payroll, POS, file fiscal-close.

## Bukti selesai
- Test: jurnal tidak seimbang ditolak; approval oleh user lain; pembuat ditolak menyetujui; ledger hanya setelah approval; posting dobel tidak menggandakan; job berulang idempoten dan resumable; isolasi tenant.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal merujuk `legend-vmyg`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
