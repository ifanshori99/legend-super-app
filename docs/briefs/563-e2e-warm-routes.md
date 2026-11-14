# Brief: engineer (Codex) — e2e warm routes (Paket A infra test)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b ws/e2e-warm-routes .worktrees/e2e-warm-routes milestone/m1`. Jangan commit `.codex/config.toml`.

## Tujuan
Mock e2e global setup hanya memanaskan route yang dibutuhkan spec yang sedang dijalankan, dan daftar route mencakup layar karyawan + payroll.

## Kartu
- legend-13q7: `e2e/mock-global-setup.ts` memanaskan 41 WARM_ROUTES di tiap shard/spec (~30 dtk). Turunkan daftar route dari spec yang dijalankan, atau beri env opt-out; lihat `docs/frontend.md` §7 "Where the time goes".
- legend-uwsl: tambah `/karyawan/slip-gaji`, kasbon, reimbursement, dan `/kelola/payroll/*` ke WARM_ROUTES (cek path asli di `apps/web/src/routes`).
(Agent Codex tidak menjalankan `bd`; CTO yang memperbarui kartu.)

## Scope
- Boleh diubah: `e2e/mock-global-setup.ts`, helper e2e baru di `e2e/`, `docs/frontend.md` §7.
- Jangan disentuh: kode aplikasi, spec e2e lain selain bila perlu tag route, CI workflow.
- Tanpa migrasi.

## Pembagian paralel (giliran pertama)
- Subagent 1: petakan route yang dipakai tiap spec di `e2e/` (goto/visit).
- Subagent 2: cari path asli route karyawan + payroll di `apps/web/src/routes`.
- Kamu: implementasi di `mock-global-setup.ts`.
- Pemegang token heavy: satu subagent saja.

## Bukti selesai
- `heavy pnpm test:e2e:mock e2e/<satu spec kecil>.spec.ts` lulus, catat waktu setup sebelum vs sesudah.
- Satu run dua spec berbeda menunjukkan hanya route spec itu yang dipanaskan (log).
- Commit di `ws/e2e-warm-routes`, push tanpa force, lapor SHA. Pra-gate AGENTS.md pada file yang diubah. Jangan merge.

## Batas kerja ulang
- tsc gagal 2x: baca log `~/.claude/state/heavy-fail/` sampai habis, betulkan semua sekaligus. Gagal ketiga: lapor.
- Jangan `pkill`/`killall` proses test atau dev server.
