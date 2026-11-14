# Brief: engineer (Claude Sonnet) — pengerasan bukti payout dari second opinion (legend-bmlwf, legend-01gg8, legend-t58lr)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show <id>` tiap kartu. Keputusan sudah diambil CTO; jangan buka ulang.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/payout-evidence-hardening .worktrees/payout-evidence-hardening origin/ws/payout-api-gaps`.

## Tujuan (satu implementer per kartu)
1. legend-bmlwf (P1, uang): langkah resolve kedua wajib memakai `resolutionEvidenceKey` yang sama dengan langkah pertama (`payroll-payout-manual.service.ts:~846`); beda bukti = ditolak, slip tidak dibebaskan.
2. legend-01gg8 (P1, uang): resolve/return memastikan objek bukti benar-benar ada di penyimpanan dan terikat tenant + batch yang sama sebelum status uang berubah (`payroll-payout-evidence.ts:~47`). Key fiktif yang cocok pola ditolak.
3. legend-t58lr (P2): jalur baca bukti (signed URL pendek atau stream) terikat tenant + batch, guard `payroll.disburse.approve`, plus DTO proposal (outcome, evidenceKey, pengusul, waktu) untuk penyetuju kedua. Tanpa UI.
Tanpa migrasi kecuali terpaksa; bila perlu, nomor 0604.

## Tingkat dan review
Tingkat K (uang). Test gagal-dulu wajib: dua bukti berbeda ditolak, key fiktif ditolak, bukti batch/tenant lain ditolak di jalur baca, tidak ada jalur bayar ulang. Satu subagent `architect` effort xhigh pada diff akhir.

## Bukti, sebelum melapor
Test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (angka subagent). Push cabang tanpa force. Jangan ubah `docs/PROGRESS.md`. Jangan merge, jangan deploy.
