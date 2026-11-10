# Brief: engineer — refund pemulihan order promo setelah kegagalan final (legend-pti5r)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/pti5r-promo-refund`, cabang `ws/pti5r-promo-refund`, dari `ws/refund-recovery-fix` (00caa599; belum masuk m1, sedang di batch48c). Lalu `pnpm worktree:setup`.

## Tujuan
`bd show legend-pti5r`. Setelah kegagalan final refund pemulihan, lapor ulang isu di order promo menghitung refundDue ~Rp0 karena `promotion_order_applications.refunded_paid_idr` dari pengajuan pertama tetap tercatat (`crm-promo-refund.ts` ~690). Betulkan: `settleFinalFailure` memberi balik `promoRecordedIdr` sekali per isu (idempotency `order-recovery-refund:<issueId>`), di bawah `lockOrder`, lewat port baru di `crm-promo-refund.ts`. Status `rejected` TIDAK berubah (keputusan h1dyy: payout tetap). Desain sebelumnya: `docs/briefs/sub-refund-recovery-final-failure.md`.
Tambahan: script/query cek data lama (kegagalan final sebelum deploy tanpa event pembalik/cap) + rencana backfill tertulis di `docs/` (jangan dijalankan ke data apa pun selain DB test).

## Kartu
`legend-pti5r`. Awal: `ghostex board associate legend-pti5r`, `bd update legend-pti5r --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya refund pemulihan, `crm-promo-refund.ts`, test terkait, docs. Tanpa migrasi kecuali terpaksa (rentang 0271, when > 1794450000000).

## Bukti selesai
- Test gagal-dulu: order promo kegagalan final lalu lapor ulang mendapat jumlah benar; pemberian balik idempoten (dua kali proses = sekali); rejected tetap; balapan dua isu di order sama; isolasi tenant.
- Test terarah; typecheck via `heavy`; prettier; `pnpm db:generate` kosong.
- Review tingkat K uang: satu `architect` effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Gagal ketiga: lapor. Tunggu job lewat notifikasi, bukan sleep. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil, bukti, file, commit, subagent dan puncak, risiko.
