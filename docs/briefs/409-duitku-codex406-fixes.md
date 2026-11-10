# Brief: engineer — perbaikan temuan Codex 406 Duitku (legend-s0u8c)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Lima temuan, dua berkas utama: Explore paralel per temuan, test-writer untuk test gagal-dulu bersamaan, implementer per berkas.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/duitku-406`, cabang `ws/duitku-406`, dari `ws/s5jup-duitku` (008cbd93). Lalu `pnpm worktree:setup`.

## Tujuan
Tutup kelima temuan di `docs/briefs/406-second-opinion-duitku-rerun-hasil.md`. Satu protokol kunci untuk webhook, poller, pembatalan POS, dan pembatalan reservasi (urutan kunci tertulis di komentar dan docs). Keputusan sudah ada: mismatch = gagal + warning (s5jup D2); paidAt = min(now, receivedAt) hanya untuk pending.

## Kartu
`legend-s0u8c`. Awal: `ghostex board associate legend-s0u8c`, `bd update legend-s0u8c --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya modul pembayaran Duitku/poller/late settlement/pembatalan POS dan reservasi, test. Migrasi bila perlu: 0274-0275, `when` > 1794470000000.

## Bukti selesai
- Test gagal-dulu per temuan, termasuk balapan nyata dua transaksi (pola test race yang ada). Unit/integration, bukan e2e.
- Test terarah; typecheck via `heavy`; prettier; `pnpm db:generate` kosong.
- Review tingkat K uang: satu `architect` effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Saat menunggu heavy, jalankan review/test-writer paralel. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil per temuan, bukti, file, subagent dan puncak, risiko.
