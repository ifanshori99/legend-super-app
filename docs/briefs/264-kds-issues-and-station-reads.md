# Brief: engineer (Sonnet) — WS-04 KDS: log remake/comp dan baca per stasiun

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/kds-issues-station` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/kds-issues-station`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0180`, `when` 1794259000000 (hanya untuk legend-4b5).

## Kartu (P2), dua jalur paralel, satu commit per kartu
Jalur A (`order_issues`, berurutan):
1. `legend-d60m`: satukan bentuk record `order_issues` antara `packages/shared/src/kitchen/schemas.ts` (sekitar :705) dan `packages/shared/src/qr-order/schemas.ts` (sekitar :44). Keputusan kontrak dicatat di komentar kartu. Kartu ini membuka legend-4qls.
2. `legend-4b5`: log remake dan comp dengan alasan, stasiun, karyawan, dan efek bahan (lihat `recipe-deduction.service.ts` dan `recipe-bom.ts`). Tabel baru, migrasi 0180, RLS tenant/outlet dipaksa.
3. `legend-0eq7`: log menampilkan nomor order, nama item, dan nama staf yang terbaca (proyeksi `listOrderIssues`).

Jalur B (`kds.routes.ts` + `kds.service.ts`, berurutan):
4. `legend-44jm`: GET capacity-rules.
5. `legend-tsp5`: jumlah tiket terbuka per stasiun.
6. `legend-rutl`: `tableLabel` dan kanal di header tiket.

Kedua jalur menyentuh `packages/shared/src/kitchen/schemas.ts` di bagian berbeda: jalur B menunggu commit d60m sebelum mengubah berkas itu, atau pakai `isolation: worktree`.

Ditunda, jangan disentuh: `legend-gt7f` (rute expo, menunggu cabang expo/pickup digabung).

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: route/service kitchen, KDS, dan order issues, schema + migrasi 0180, `packages/shared/src/kitchen/*` dan bagian `order_issues` di `qr-order/schemas.ts`, fixture, test. Web `features/ws04-kds/*` hanya untuk menyambung field yang sudah ada di layar sekarang (hitungan stasiun, label meja/kanal); tampilan baru: buat kartu UI dan sebut kontraknya. Jangan: expo/pickup, payment/refund, posting jurnal.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu tiap kartu, termasuk isolasi tenant/outlet untuk log dan hitungan stasiun, dan comp tidak mengurangi bahan dua kali.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api, shared, web lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): 4b5 menyentuh migrasi dan biaya bahan, jadi satu `architect` untuk diff gabungan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA), migrasi (`when`, prevId), bukti, file berubah, kontrak baru untuk UI, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
