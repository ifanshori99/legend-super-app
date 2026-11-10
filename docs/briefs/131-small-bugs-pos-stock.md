# Brief 131: engineer kecil — tiga bug kecil POS dan stok (legend-fbms, legend-2tcj, legend-t8xt)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Tingkat S: `reviewer` Sonnet sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/small-bugs-pos-stock -b ws/small-bugs-pos-stock milestone/m1`. Jangan pakai `--worktree` Ghostex.
Sebelum mulai tiap kartu: cek apakah sudah dibetulkan di `integ/m1-batch3` (`git grep`/`git log`). Bila sudah, `bd comment` dan lewati.

## Kartu (baca `bd show <id>` dulu)
1. `legend-fbms`: pesanan POS bertotal nol tidak memancarkan `order.paid`, jadi stok tidak terpotong (`pos-order.service.ts`, sekitar `if (order.totalIdr > 0)`). Test: pesanan 100% diskon tetap memotong stok tepat sekali.
2. `legend-2tcj`: jalur reject stock count membaca hasil approval tanpa kunci chain (`inventory-count.service.ts`, `getApprovalChainOutcome`). Pakai `resolveApprovalChainOutcome` seperti jalur lain. Test balapan approve vs reject (`pg_locks`, bukan sleep).
3. `legend-t8xt`: test flaky `pos-shift.test.ts` urutan outbox saat timestamp sama. Betulkan dengan tie-breaker deterministik di query atau test.
Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress` di awal; `--status review` + `bd comment` saat melapor.

## Scope
- Boleh: `pos-order.service.ts` (hanya bagian emisi `order.paid`), `inventory-count.service.ts`, `inventory-count.shared.ts`, query outbox bila perlu, test terkait.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, modul refund/DOIT/promo/pajak, `pos-cash-guard.ts`, `pos-order-payment.ts`.

## Bukti selesai
`LEGEND_TEST_FILES="<file terkait>" pnpm test` dari root worktree (jalankan `pos-shift.test.ts` 3 kali untuk t8xt), typecheck dan lint lewat `heavy`. Commit lokal di `ws/small-bugs-pos-stock`, jangan push.

## Laporan
SHA, hasil gate per kartu, kartu yang dilewati karena sudah dibetulkan, bead baru.
