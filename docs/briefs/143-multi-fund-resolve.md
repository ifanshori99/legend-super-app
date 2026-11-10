# Brief 143: engineer — beberapa dana tak teralokasi di satu tagihan (legend-knev)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/refund-escalation` (446d05b3, berisi perubahan terbaru `mapFundEvidence` dan sweep refund).
`git worktree add .worktrees/multi-fund -b ws/multi-fund ws/refund-escalation`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-knev` (baca juga komentarnya). Kontrak saat ini mengandaikan satu dana tak teralokasi = seluruh kelebihan bayar tagihan. Bila satu tagihan punya beberapa dana, resolve ditolak 409 dan refund sah terhalang. Modelkan jumlah per dana: tiap dana diselesaikan sebatas jumlahnya sendiri, total semua dana tidak melebihi kelebihan bayar, tetap fail-closed untuk kasus yang benar-benar ambigu.
Di awal: `ghostex board associate legend-knev`, `bd update legend-knev --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: service dana tak teralokasi dan resolve-nya, kontrak terkait di `packages/shared` (validator/DTO), test di `apps/api/src/test/`, migrasi baru hanya bila perlu (laporkan nomornya; `ws/refund-promo` sudah memakai 0106).
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter dan webhook DOIT, `crm-promo-refund.ts`, `refundPosOrder`, UI.

## Bukti selesai
- Test: dua dan tiga dana di satu tagihan bisa diselesaikan satu per satu; jumlah melebihi dana sendiri ditolak; total melebihi kelebihan bayar ditolak; resolve ganda idempoten; balapan dua resolve bersamaan aman (`pg_locks`, bukan sleep); kasus satu dana tidak berubah; isolasi tenant.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong atau migrasi tercatat.
- Commit lokal di `ws/multi-fund`, jangan push. Tulis `docs/briefs/144-second-opinion-multi-fund.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, migrasi, hasil gate, temuan review K, file berubah, bead baru.
