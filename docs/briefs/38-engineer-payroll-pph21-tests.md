# Brief: engineer — suite test referensi PPh 21 dan payroll (legend-5cnk)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-pph21-tests`, cabang `ws/payroll-pph21-tests` (dari `main`). Jangan pindah cabang.

## Tujuan
PRD v1.7 §3 F30, PAYR-03, §2 R15 (`docs/PRD.md`): minimal 30 kasus referensi dengan nilai harapan yang dihitung **independen** dari engine (jangan menyalin rumus engine): varian PTKP, TER bulanan dan perhitungan tahunan Desember, gross / gross-up / net (taxScheme per komponen), karyawan masuk/keluar di tengah periode, THR, bonus, tanpa NPWP (surcharge `noTaxIdSurchargeBp`), dan `pph21WithheldIdr` yang bisa diverifikasi. Detail dan catatan second-opinion: `bd show legend-5cnk`.

Bila engine belum mendukung surcharge tanpa NPWP atau taxScheme gross/gross-up/net, implementasikan di engine (catatan bead mewajibkannya) dengan test.

## Kartu
`legend-5cnk`. Di awal: `ghostex board associate legend-5cnk` dan `bd update legend-5cnk --status in_progress`. Saat melapor: `bd update legend-5cnk --status review` dan `bd comment legend-5cnk "<ringkasan bahasa biasa>"`.

## Catatan
- Area uang dan pajak: tiap nilai harapan diberi sumber (pasal/PMK/PP dan langkah hitung di komentar fixture). Integer IDR, aturan pembulatan sesuai ketentuan. Bila aturan tidak pasti, tulis di laporan, jangan menebak diam-diam.
- Pakai Context7 atau sumber resmi DJP untuk tabel TER/PTKP terbaru.

## Scope
- Boleh: `apps/api/src/test/payroll*.test.ts`, `apps/api/src/test/fixtures/payroll/**`, engine payroll/PPh 21 di `apps/api/src/services/payroll*` seperlunya, kontrak payroll di `packages/shared` bila perlu.
- Jangan: `apps/web/`, `design/`, modul lain.

## Bukti selesai
- ≥30 kasus lulus; daftar kasus dan sumbernya di laporan.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/payroll-pph21-tests`, pesan merujuk `legend-5cnk`. Jangan push, jangan merge.

## Laporan
Hasil, daftar kasus, selisih yang ditemukan di engine, file berubah, commit, risiko tersisa.
