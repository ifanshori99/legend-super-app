# Brief 153: engineer — matriks approval refund default mulai Rp0 dengan langkah supervisor (legend-zi9o)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang, approval): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base `integ/m1-batch5` (berisi refund-escalation, refund-promo, multi-fund). Pastikan `ws/refund-approval` 7c24b7b8 ada di base (`git merge-base --is-ancestor`); bila tidak, laporkan sebelum mulai.
`git worktree add .worktrees/refund-tier -b ws/refund-tier integ/m1-batch5`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-zi9o`, PRD `:541` dan keputusan D14. Fix Codex refund membuat jalur refund langsung butuh `payment.reconcile` + `pos.refund.approve`. Matriks approval default harus punya tier mulai Rp0 dengan langkah supervisor lewat inbox, supaya supervisor bisa menyetujui refund tanpa izin reconcile, sesuai PRD. Tenant yang sudah punya matriks sendiri tidak berubah. Tenant baru dan seed mendapat default yang benar. Bila tenant lama butuh backfill, pakai migrasi data idempoten (laporkan nomornya).
Di awal: `ghostex board associate legend-zi9o`, `bd update legend-zi9o --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: seed/default approval policies, service matriks approval, kontrak shared terkait, migrasi data bila perlu, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter dan webhook DOIT, `crm-promo-refund.ts`, logika `refundPosOrder` selain titik approval, UI.

## Bukti selesai
- Test: refund Rp0 sampai batas tier pertama lewat langkah supervisor di inbox; tier di atasnya tetap butuh langkah sesuai PRD; supervisor tanpa `payment.reconcile` bisa menyetujui lewat inbox tetapi tidak lewat jalur langsung; matriks kustom tenant tidak tertimpa; isolasi tenant; approval tidak bisa dipakai ulang.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong atau migrasi tercatat.
- Commit lokal di `ws/refund-tier`, jangan push. Tulis `docs/briefs/154-second-opinion-refund-tier.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, migrasi, hasil gate, temuan review K, bead baru.
