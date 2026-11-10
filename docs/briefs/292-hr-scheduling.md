# Brief: engineer (Sonnet) — WS-10 penjadwalan karyawan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/hr-scheduling` dari `milestone/m1` (ujung terbaru). Worktree `.worktrees/hr-scheduling`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan. Nomor migrasi dipesan: `0199`, `when` 1794278000000, satu migrasi (merge train akan merantai ulang bila perlu).

## Tujuan
`legend-jstx` (P2). Baca kartu lengkap (`bd show legend-jstx`) dan bagian PRD v1.7 yang dirujuknya; kriteria penerimaan kartu adalah definisi selesai. Inti: template shift, roster, publikasi + notifikasi (pakai outbox notifikasi yang ada), tukar/gantikan shift dengan aturan kepatuhan (melanggar hanya dengan persetujuan eksplisit), HR-05. Data pribadi karyawan: tingkat K untuk bagian itu. Mulai dengan 2 sampai 3 `Explore` paralel untuk pola modul serupa di m1 (schema `tenantIdColumn`, RLS lewat `.custom.sql`, service, route, event outbox, izin di `packages/shared/src/permissions.ts`). Sesudah skema masuk, potongan service/route lewat `implementer` paralel di berkas terpisah.

## Kartu
Awal: `ghostex board associate legend-jstx`, `bd update legend-jstx --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Bagian yang butuh keputusan bisnis atau UI: catat di laporan, pakai default yang bisa diubah, jangan menunggu.

## Scope
Boleh: schema, migrasi, service, route, kontrak shared modul ini, tes. Jangan: UI web, modul lain di luar kartu.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Tes migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Tes gagal-dulu untuk tiap kriteria penerimaan, termasuk isolasi tenant dan outlet serta izin.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- `tsc` api dan shared lewat `heavy` sekali; eslint + prettier.
- Review: satu `reviewer` (tingkat S); bila menyentuh uang, akses, atau data pribadi, satu `architect` (tingkat K).

## Laporan
Sekali di akhir: SHA, migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, keputusan default yang perlu founder, risiko, jumlah subagent dan puncak bersamaan.
