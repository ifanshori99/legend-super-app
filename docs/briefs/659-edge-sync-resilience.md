# Brief: engineer — ketahanan sync edge (legend-n1fzg, legend-btx4d, legend-dy7pc)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang/sync: "jangan sampai rugi".

## Konteks
`ws/edge-contract-followups` (df90b7ac5) menyelesaikan producer struk, provider gateway, dan customerAttachedBy. Tiga celah tersisa, keputusan CTO 14 Nov ada di deskripsi bead:
- `legend-n1fzg`: struk dari order yang ditolak permanen (`order_exists`, `legacy_payload`) menahan run. Lewati struk itu, catat konflik yang terlihat finance, lanjutkan struk lain. Jangan hapus-buku diam-diam.
- `legend-btx4d`: event di atas batas frame menahan antrean outlet. Pindahkan ke dead-letter dengan alarm ops; antrean lanjut; event tetap tersimpan.
- `legend-dy7pc`: order QR yang sudah ada di cloud lalu dibayar di kasir edge (`order_exists`). Desain dulu (catatan di `docs/design/edge-order-ingest.md`, review subagent `architect` xhigh), lalu implementasi: tautkan pembayaran edge ke order cloud yang ada, idempoten, tanpa bayar ganda. Bila desain butuh keputusan bisnis, berhenti di desain dan lapor.

## Repo
Worktree dari `origin/ws/edge-contract-followups`: `git worktree add .worktrees/edge-resilience-659 -b ws/edge-sync-resilience origin/ws/edge-contract-followups`, `pnpm worktree:setup`. Migrasi rentang **0538-0541**.

## Test gagal-dulu
n1fzg: struk berikutnya tetap tergabung, konflik tercatat sekali. btx4d: antrean di belakang event besar terkirim, dead-letter tercatat sekali, alarm keluar. dy7pc: order QR dibayar di edge tercatat lunas sekali, tidak ada order kedua, total uang cloud = edge.

## Review
Tingkat K: satu subagent `architect` effort xhigh pada diff, maks 2 ronde.

## Bukti selesai
Test terarah edge/pos lewat `heavy`, typecheck api (+ web bila tersentuh) lewat `heavy`, prettier + eslint, `db:generate` kosong, registry migrasi. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
