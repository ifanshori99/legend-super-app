# Brief: engineer — triase 7 kartu WS backend lama (baca saja)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu"), lalu ikuti. Tugas ini hanya membaca dan menulis komentar kartu: tidak ada perubahan kode, tidak ada commit.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Baca kode di `integ/m1-batch31` (d7a95d0c) lewat `git show d7a95d0c:<path>` atau worktree baca `.worktrees/triage-ws` (`git worktree add --detach .worktrees/triage-ws d7a95d0c`, hapus di akhir). Jangan checkout di folder utama.

## Tujuan
Kartu ini dibuat di awal proyek dan banyak isinya mungkin sudah dibangun oleh slice lain. Untuk tiap kartu, tentukan apa yang sudah ada dan apa yang belum, dibanding PRD `docs/PRD.md` bagian yang disebut kartu:
- `legend-vm6`, `legend-usw3`, `legend-5rzy` (expo, runner, pickup; satu area)
- `legend-316` (goods receipt, invoice supplier, 3-way match, pembayaran supplier, retur)
- `legend-j2l2` (payroll engine: komponen, BPJS, THR, kasbon, reimburse, service charge)
- `legend-5f7` (refund via gateway/manual + failover), `legend-m0k` (orkestrasi EDC)

Spawn 4 `Explore` paralel dalam satu giliran (satu per area), tiap prompt merujuk brief ini dan kartunya (`bd show <id>`).

## Hasil per kartu
`bd comment <id> "<triase>"` dengan: sudah ada (file:baris), belum ada (butir PRD), rekomendasi: (a) tutup karena sudah lengkap, (b) pecah jadi kartu kecil, atau (c) kerjakan utuh. Untuk (b): buat kartu kecil `bd create "<judul>" -t task -p <1-3> -l <area>` dengan cakupan berkas jelas, lalu `bd dep add <kartu kecil> <kartu induk>` bila perlu. Jangan menutup kartu: hanya CTO yang menutup. Tandai tingkat K (uang, pajak, auth, migrasi) di judul kartu kecil bila relevan.

## Laporan
Sekali: tabel per kartu (sudah ada, belum ada, rekomendasi), id kartu kecil baru dengan prioritas, kartu yang bisa ditutup, dan urutan kerja yang kamu sarankan (mana yang bisa paralel). Jumlah subagent dan puncak bersamaan. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
