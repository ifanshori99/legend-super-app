# Brief: engineer (Sonnet) — refund tidak boleh membayar intent QR pay-first yang masih hidup (legend-xtzpb)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/refund-qr-payfirst-guard` dari `milestone/m1` 4c818489. Worktree `.worktrees/refund-qr-payfirst-guard`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-xtzpb` (P2 bug, tingkat K: uang). Baca `bd show legend-xtzpb` dan `bd comments legend-xtzpb`. Akar masalah sudah dicatat di kartu: `refundableBalance` tidak memperhitungkan intent QR pay-first yang masih hidup.

## Kartu
Di awal: `bd update legend-xtzpb --status in_progress`. Saat melapor: `--status review` + `bd comment`.

## Scope
Boleh: service/route refund dan payment intent yang menghitung saldo refund, test. Jangan: migrasi, Better Auth/akses, edge, pajak, UI, payroll.

## Bukti selesai
- Test yang gagal di basis (refund staff atas penjualan QR pay-first yang intent-nya masih hidup), lalu lulus. Test refund lama tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review kuat (aturan baru Q48): satu subagent `architect` saja. Temuan nyata dibetulkan.
- Brief Codex `docs/briefs/240b-second-opinion-refund-qr-payfirst.md` (tidak di-commit): rentang diff, berkas berisiko, invariant.

## Laporan
Sekali: akar masalah, perbaikan, bukti, file berubah, SHA, risiko tersisa, jumlah subagent. Akar masalah ternyata beda atau butuh desain baru: berhenti dan lapor (CTO akan naikkan ke Opus).
