# Brief: engineer — perbaikan temuan Codex 411 (loyalty expiry + consent), kartu legend-37wom

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Giliran pertama: Explore + test-writer + satu implementer per temuan (berkas tidak bertumpuk), semua sekaligus.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/fix-411`, cabang `fix/codex-411-loyalty-consent` dari `origin/milestone/m1`. `pnpm worktree:setup`.

## Temuan (keputusan CTO: betulkan semua)
1. P1 `apps/api/src/services/loyalty-expiry.service.ts:217` — `settle()` memindahkan redeem lama ke lot yang dipulihkan setelah kedaluwarsa. Skenario: A dipakai R1, B dipakai R2, R1 dibatalkan setelah A kedaluwarsa; R2 pindah ke A, poin B tetap hidup, poin pulihan tidak kedaluwarsa di sweep berikut. Batasi realokasi berdasar waktu restore dan expiry.
2. P1 `apps/api/src/services/consent.service.ts:206` — pencabutan marketing oleh staf tidak menyinkronkan `marketingOptIn`; segmen `marketing_opt_in` masih memasukkan member. Sinkronkan profil dalam transaksi pencatatan consent (atau turunkan dari keputusan terbaru).
3. P2 `apps/api/src/services/customer360.service.ts:247` — grant versi baru tidak menutup grant lama; setelah v1, v2, cabut, v1 masih aktif. Tutup periode lama saat grant baru dan semua periode terbuka saat cabut.

Migrasi bila perlu backfill: nomor sementara, merge train yang renumber.

## Bukti selesai
Test gagal-dulu per skenario di atas (unit/integration), lalu lulus. tsc + eslint + test area via `heavy`. Satu subagent architect effort xhigh (poin = nilai uang, data pribadi) atas diff; temuan nyata dibetulkan.

## Kartu
`ghostex board associate legend-37wom`, `bd update legend-37wom --status in_progress`. Selesai: `--status review` + `bd comment`.

## Laporan
Commit, push. Hasil, bukti test, subagent dan puncak, risiko.
