# Brief: engineer (Codex) — edge: kesegaran katalog + stream promo/voucher (legend-10nex, legend-09sxa)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Konteks: `docs/briefs/564-edge-sync.md`, `564-edge-sync-keputusan.md`.

## Mulai dengan status
`bd show legend-10nex legend-09sxa` dan `git log --all --oneline --grep=10nex --grep=09sxa`. Catatan 10nex menyebut "putaran 2 pushed" (promo basi mati di edge, boot DB fail closed, review-q61). Cari cabangnya; cek apa yang sudah ada di milestone/m1 (ab574d58). Kerjakan hanya sisa.

## Tujuan
1. legend-10nex: status kesegaran per stream katalog kritis di edge; kasir mendapat peringatan, owner alarm; kebijakan jual saat katalog basi sesuai keputusan founder (lihat komentar kartu / `bd memories edge`). Test termasuk offline.
2. legend-09sxa: stream sinkron `catalog:promotions` dan `catalog:vouchers` ke edge. Founder Q66: voucher/promo berkuota hanya online (d47d35f9) — edge tidak boleh menebus voucher/promo berkuota saat offline. Promo/voucher tanpa kuota boleh di edge bila datanya segar.

## Uang (Jangan sampai rugi)
Test gagal-dulu: promo/voucher basi atau berkuota tidak bisa dipakai di edge offline; kuota tidak bisa terpakai ganda lewat edge + cloud; diskon tidak melebihi aturan cloud. Ragu: pilih yang membatasi, lapor CTO.

## Repo
Worktree dari Ghostex basis `milestone/m1`. Cabang `ws/edge-catalog-fresh` (atau lanjutkan cabang putaran 2 bila belum tergabung: rebase ke m1). Migrasi bila perlu: 0414-0416.

## Bukti selesai
- Test terarah lulus, typecheck api+edge.
- Satu subagent architect effort xhigh (uang) mereview diff; temuan nyata dibetulkan.
- Jangan `pnpm check` penuh, jangan sentuh milestone/m1 atau main, jangan deploy. Lapor SHA dan test.
