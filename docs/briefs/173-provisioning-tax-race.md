# Brief: engineer — race backfill provisioning dan pajak default (legend-dq0n, legend-hd1m)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/provisioning-race` dari ujung `milestone/m1` terbaru, worktree `.worktrees/provisioning-race`, `worktree:setup`. Jangan checkout di folder utama.

## Tujuan
1. `legend-dq0n` (P1, tingkat K): backfill pajak default berpacu dengan owner yang membuat aturan pajak, menghasilkan aturan ganda dan order gagal (`tax-provisioning.service.ts:137`). Detail: `docs/briefs/130-second-opinion-tax-default.result.md`.
2. `legend-hd1m` (P2): race backfill CoA dan tipe lokasi wajib terlewat. Detail: `docs/briefs/122-second-opinion-provisioning.result.md`.
Satu pola lock tenant bersama untuk backfill dan semua penulis owner (CoA, pajak). Cek dulu apakah `ws/service-charge-default` (lock `lockServiceChargeConfig`) sudah di m1; selaraskan polanya, jangan bentrok urutan kunci.

## Kartu
`ghostex board associate legend-dq0n`, `ghostex board associate legend-hd1m`, `bd update <id> --status in_progress`. Saat lapor: `--status review` dan `bd comment` bahasa biasa.

## Scope
- Boleh: `tax-provisioning.service.ts`, `tax.service.ts` (bagian penulis aturan), service provisioning CoA/lokasi, migrasi backfill bila perlu (catat nomor dan `when`), test terkait.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, auto-journal, modul refund, `pos-shift.service.ts`.

## Bukti selesai
Test reproduksi race gagal dulu (dua transaksi, cek `pg_locks`). `LEGEND_TEST_FILES` daftar eksplisit (`src/test/*provision*`, `*tax*`, `*service-charge*`, dibuat dengan bash nullglob, lewat `bash -c`); laporkan jumlah file jalan. tsc api/shared lewat `heavy`, eslint, prettier, kontrak node. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/173b-second-opinion-provisioning-race.md` (tidak di-commit).

## Laporan
Sekali setelah kedua kartu selesai: hasil, bukti, file berubah, SHA, urutan kunci akhir, risiko, catatan rilis (backfill di luar jam operasional), kebutuhan dari CTO. Commit lokal, jangan push, jangan merge.
