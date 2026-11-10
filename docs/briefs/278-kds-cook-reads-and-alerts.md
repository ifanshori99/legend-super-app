# Brief lanjutan G6yqg: bacaan KDS untuk cook dan alert QR

Lanjutan di thread yang sama. Aturan sama dengan brief 264 dan 275.

## Repo
Cabang baru `ws/kds-cook-reads` dari `ws/kds-capacity-rules` (34f0dc53; antre merge train), worktree `.worktrees/kds-cook-reads`, `worktree:setup`. Jangan push, jangan merge. Tanpa migrasi; bila 078b ternyata butuh tabel notifikasi, berhenti dan lapor.

## Tujuan
1. `legend-gt7f` (P2, K akses) diperluas: cook/barista yang hanya memegang `kds.ticket.process` di outlet itu bisa membaca (a) label stasiun dan (b) aturan kapasitas stasiun, lewat endpoint baca yang dicakup KDS (mis. di bawah `/api/outlets/:outletId/kitchen/...`), bukan dengan melonggarkan `menu.item.view` atau `kds.station.manage`. Hanya field yang layar KDS perlu; PUT capacity-rules tetap `kds.station.manage`. Cakupan outlet dan stasiun ditegakkan di SQL.
2. `legend-078b` (P2): alert staf untuk baris QR tanpa stasiun dapur (audit `kitchen_ticket.unrouted`) dan pemberitahuan void dapur untuk pesanan QR (`order.kitchen_voided`) lewat mekanisme event/notifikasi yang sudah ada. Explore dulu mekanisme push yang sudah ada; jangan bangun transport baru.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Komentari `legend-xz3ll` dengan kontrak baca baru untuk UI.

## Bukti selesai
- Test gagal-dulu: cook outlet A membaca label + kapasitas outlet A; cook outlet B dan tenant lain ditolak; cook tidak bisa PUT; field sensitif tidak ikut; alert unrouted dan void QR muncul sekali per kejadian (idempoten) dan hanya ke staf outlet itu.
- Tes terarah, sebut jumlah file dan tes. Kontrak root bila `packages/shared` berubah. Typecheck shared/api/web lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K akses): satu `architect`. Tambahkan bagian ke `docs/briefs/264b-second-opinion-kds.md`.

## Laporan
Sekali di akhir: SHA, bukti, file berubah, kontrak UI, risiko, jumlah subagent dan puncak bersamaan.
