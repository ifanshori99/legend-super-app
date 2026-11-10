# Brief: engineer — perbaikan temuan Codex 415 (Wi-Fi edge), kartu legend-tz5to

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Giliran pertama: Explore + test-writer + dua implementer (service cloud / edge worker), sekaligus.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/fix-415`, cabang `fix/codex-415-wifi` dari `origin/milestone/m1`. `pnpm worktree:setup`.

## Temuan (keputusan CTO: betulkan semua)
1. P1 `apps/api/src/services/wifi-quota.service.ts:148` — ledger belanja tidak difilter outlet; belanja di A menambah kuota sesi di B. Filter berdasarkan outlet sesi.
2. P2 `apps/api/src/services/wifi-session.service.ts:400` — riwayat pemakaian harian tidak difilter outlet. Batasi pada outlet sesi.
3. P1 `apps/api/src/edge/wifi-quota-queue-worker.ts:222` — durasi grant dari snapshot lama; sinkron tertunda bisa memberi ulang waktu terpakai. Hitung sisa terkini; retry tidak mereset durasi.
4. P1 `wifi-quota-queue-worker.ts:215` — event baru ditandai diterapkan saat grant lama masih `pending`/`unknown`; tambahan kuota bisa hilang. Tunggu hasil grant lama, cocokkan versi/kedaluwarsa sebelum menandai selesai.

## Bukti selesai
Test gagal-dulu per temuan, lalu lulus. tsc + eslint + test area via `heavy`. Satu subagent reviewer sonnet atas diff (tingkat S, bukan uang); temuan nyata dibetulkan.

## Kartu
`ghostex board associate legend-tz5to`, `bd update legend-tz5to --status in_progress`. Selesai: `--status review` + `bd comment`.

## Laporan
Commit, push. Hasil, bukti test, subagent dan puncak, risiko.
