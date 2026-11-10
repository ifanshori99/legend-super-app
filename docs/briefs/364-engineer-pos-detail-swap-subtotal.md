# Brief: engineer — posOrderDetailSchema subtotal setelah swap dapur (legend-kxoyf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (total uang): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/kxoyf-pos-swap -b ws/kxoyf-pos-swap origin/ws/pc51h-bill-swap` (8b0b8d58). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Reproduksi dulu: swap dapur (lebih mahal, lebih murah, sama harga) pada order POS kasir, lalu endpoint detail order POS. Bila 422/invalid: perbaiki dengan pola yang sama seperti pc51h (`swapReplacementIdr` di `qrOrderSchema`, diisi dari `order_issues.replacement_order_item_id`): total order tetap beku, selisih lewat `order_issue_charges`. Order tanpa swap tetap ketat. Bila tidak ada bug: laporkan bukti, tutup kartu.

## Kartu
`legend-kxoyf`. `ghostex board associate legend-kxoyf`, `bd update legend-kxoyf --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: `posOrderDetailSchema` di `packages/shared`, mapping DTO order POS di `apps/api`, test.
- Jangan disentuh: pembayaran/gateway, modul charge (`order-recovery-charge*.ts`), HRIS, edge, migrasi.

## Bukti selesai
- Test gagal-dulu 3 arah swap pada order POS + order tanpa swap dengan subtotal salah tetap ditolak.
- Typecheck dan test terarah lewat `heavy`. Architect review, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
Bug nyata atau tidak, SHA, test gagal-dulu, temuan review, risiko.
