# Brief: engineer — cuti, saldo, libur, lembur (legend-hggk)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hris-leave`, cabang `ws/hris-leave` (dari `main`). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
PRD v1.7 §3 F29 (`docs/PRD.md`), WS-10: jenis cuti, saldo, akrual, carry-over, kalender libur, pengajuan lembur dengan formula yang bisa diatur; persetujuan lewat matriks approval (`approval_requests`) yang sudah ada. Pakai kontrak HRIS yang sudah ada di `packages/shared` bila ada; tambah bila kurang. Detail dan kriteria: `bd show legend-hggk`.

## Kartu
`legend-hggk`. Di awal: `ghostex board associate legend-hggk`, `bd update legend-hggk --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan
- Saldo cuti tidak boleh negatif kecuali kebijakan mengizinkan; pengajuan bersamaan tidak boleh memakai saldo dua kali (lock). Akrual idempoten per periode.
- Lembur menghasilkan data untuk payroll; nilai uang integer IDR; formula berversi.
- Tabel baru: `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`, tabel operasional punya `outlet_id`. Jangan salin migration 119connect.
- Migration: drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/db/schema/hris*.ts`, migration baru, `apps/api/src/services/hris*.ts`, `apps/api/src/routes/hris*.routes.ts`, `apps/api/src/test/hris*.test.ts`, kontrak HRIS di `packages/shared`, satu-dua baris registrasi.
- Jangan: payroll engine/PPh21, `apps/web/`, modul lain.

## Bukti selesai
- Test: akrual dan carry-over, pengajuan cuti → approval matriks → saldo berkurang; tolak; pengajuan bersamaan; hari libur tidak memotong saldo; lembur dengan formula; isolasi tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir; jangan ulang run basi). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal merujuk `legend-hggk`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
