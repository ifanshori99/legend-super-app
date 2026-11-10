# Brief: engineer — web POS kasir menerima angka laci null (legend-ekaca)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pos-kasir-null-figures` dari ujung `milestone/m1` terbaru, worktree `.worktrees/pos-kasir-null-figures`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-ekaca` (P2). Sejak shift-blind-close (sudah di m1), DTO shift buta (kasir, supervisor pada shift sendiri) mengirim tujuh angka laci sebagai null (cashSales..cashDrop, expected, variance). `apps/web/src/features/ws04-pos-kasir/types.ts` (sekitar :258-262 dan :408-412) masih mengetiknya `number`. Ubah tipe ke `number | null` (ikuti skema shared bila sudah ada), dan pastikan setiap layar kasir yang menampilkan angka itu menampilkan "—" (bukan 0, bukan "Rp NaN"), sama seperti pola day-close di ws/day-report-blind. Mock (`mock-wire.ts`) diberi skenario buta supaya layar teruji. Detail: `bd show legend-ekaca`, `bd show legend-4wrfd`.

## Kartu
`ghostex board associate legend-ekaca`, `bd update legend-ekaca --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `apps/web/src/features/ws04-pos-kasir/**` (types, komponen shift, mock-wire), helper format rupiah web bila perlu, test web/e2e mock. Jangan: API, skema shared kecuali tipe yang memang salah (catat), layar day-close (cabang lain sedang mengubahnya), `legend-7mlf` (menunggu review UI founder).

## Bukti selesai
Test atau e2e mock gagal dulu: shift buta menampilkan "—" di semua tempat angka laci; shift biasa tetap tampil angka. tsc web lewat `heavy`, eslint, prettier, e2e mock terkait lewat `heavy`. Screenshot satu layar shift buta 390 dan 1440 di laporan. Review: satu `reviewer` (tingkat S) dan `ui-auditor` untuk screenshot.

## Laporan
Sekali: hasil, bukti, file berubah, SHA, path screenshot, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
