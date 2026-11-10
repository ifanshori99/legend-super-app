# Brief: engineer — perbaikan temuan Codex 419 (gabung meja), kartu legend-mgavf

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Giliran pertama: Explore + test-writer + satu implementer (satu berkas, dua temuan berurutan), sekaligus.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/fix-419`, cabang `fix/codex-419-table-merge` dari `origin/milestone/m1`. `pnpm worktree:setup`.

## Temuan (keputusan CTO)
1. P1 `apps/api/src/services/table-session-operations.service.ts:566` — cek pembayaran sebelum lock order; tender POS yang commit saat merge menunggu lock lolos, settlement QR tidak berkurang, pelanggan ditagih dua kali. Kunci order kedua sesi (urutan lock deterministik) lalu periksa ulang pembayaran sebelum merge.
2. P1 `table-session-operations.service.ts:632` — merge memindah order tapi biaya selisih swap terbuka tertinggal di sesi sumber; hilang setelah sumber ditutup. Pindahkan biaya terkait atomik (pilihan utama) atau tolak merge selama ada biaya terbuka.
3. P2 `:568` (tolak gabung sesi dibayar sebagian): TIDAK diubah. Guard tetap. Pastikan pesan error jelas untuk kasir.

## Bukti selesai
Test gagal-dulu: dua request paralel (tender + merge) dan merge dengan biaya swap terbuka; lalu lulus. tsc + eslint + test area via `heavy`. Satu subagent architect effort xhigh (uang) atas diff; temuan nyata dibetulkan.

## Kartu
`ghostex board associate legend-mgavf`, `bd update legend-mgavf --status in_progress`. Selesai: `--status review` + `bd comment`.

## Laporan
Commit, push. Hasil, bukti test, subagent dan puncak, risiko.
