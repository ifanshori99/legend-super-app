# Brief: engineer (Claude Sonnet) — tindak lanjut payout: tunai tanpa bukti, tarik usulan langkah-1 (legend-styqg, legend-5rh26)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show` tiap kartu. Keputusan sudah diambil CTO.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/payout-followups .worktrees/payout-followups origin/ws/payout-evidence-hardening`.

## Tujuan (satu implementer per kartu)
1. legend-styqg: serah terima tunai menolak `evidenceKey` non-null dengan 422 (bukti tunai tidak bisa diunggah, jadi key apa pun palsu).
2. legend-5rh26: pengusul langkah-1 (atau penyetuju lain dengan `payroll.disburse.approve`) bisa menarik usulan resolve langkah-1 yang belum disetujui langkah-2; slip kembali ke keadaan sebelum usulan, tercatat di audit. Tidak boleh ada jalur yang membebaskan slip untuk dibayar ulang. Baris lama yang key-nya tidak pernah diunggah bisa ditarik.
Tanpa migrasi kecuali terpaksa (nomor 0608, lapor dulu).

## Tingkat dan review
Tingkat K (uang). Test gagal-dulu: tunai + key ditolak; tarik usulan mengembalikan slip tanpa membebaskannya; setelah ditarik, usulan baru dengan bukti benar bisa jalan; tenant lain ditolak. Satu subagent `architect` effort xhigh pada diff akhir.

## Bukti, sebelum melapor
Test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api+web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (angka subagent). Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
