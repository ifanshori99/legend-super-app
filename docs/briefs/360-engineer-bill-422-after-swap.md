# Brief: engineer — GET /bill 422 setelah swap (legend-pc51h)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (total tagihan = uang): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/pc51h-bill-swap -b ws/pc51h-bill-swap milestone/m1`. Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Setelah swap item dapur ke pengganti yang lebih mahal, subtotal/total order ikut benar dan `GET /bill` tidak lagi 422. Reproduksi dulu, cari akar masalah, baru perbaiki. Putuskan dari kode+PRD siapa menanggung selisih (tamu ditagih vs outlet menanggung); bila PRD tidak jelas, ikuti perilaku charge order yang ada (`order_issue_charges`) dan catat di laporan.

## Kartu
`legend-pc51h`. Di awal: `ghostex board associate legend-pc51h` dan `bd update legend-pc51h --status in_progress`. Saat melapor: `bd update legend-pc51h --status review` dan `bd comment legend-pc51h "<ringkasan>"`.

## Masukan
- `order-recovery-swap-kitchen.ts:245-261` (Grep nama file).
- Cabang `ws/i83ls-fix` (3b3e2be3) mengubah charge order di sekitar area ini; jangan sentuh file yang diubah cabang itu (`git diff --stat 5558eca2...3b3e2be3`). Bila tak terhindarkan, catat untuk merge train.

## Scope
- Boleh diubah: service swap/recovery order dan test-nya.
- Jangan disentuh: pembayaran/gateway, modul charge di ws/i83ls-fix, HRIS, edge.
- Migrasi: hanya bila perlu, nomor 0247 saja, FK inline, migrator non-superuser.

## Bukti selesai
- Test gagal-dulu: swap ke item lebih mahal lalu `GET /bill` (merah 422 sebelum fix), plus swap ke item lebih murah dan sama harga.
- Typecheck dan test terarah lewat `heavy`. Review architect, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Sebelum melapor
Commit, push cabang kerja, update `docs/PROGRESS.md`.

## Laporan
SHA, akar masalah, test gagal-dulu, keputusan selisih harga, temuan review, risiko.
