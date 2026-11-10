# Brief: engineer (Sonnet) — WS-08 API halaman member (PWA)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/member-pwa-api` dari `milestone/m1` (ujung terbaru). Worktree `.worktrees/member-pwa-api`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan. Migrasi hanya bila perlu: nomor dipesan `0193`, `when` 1794272000000, satu migrasi.

## Tujuan
`legend-u57q` (P2, tingkat K: poin dan penukaran hadiah bernilai uang, persetujuan berversi). PRD v1.7 bagian 3.20 Halaman Member. UI sudah ada di `apps/web/src/features/ws08-member` (masih memakai mock). Bangun rute `/api/member/*` sesuai `memberEndpoints` di `@starter/shared/crm`: overview (termasuk versi kebijakan persetujuan aktif per tujuan), poin, misi, hadiah, tukar hadiah (LOY-03: atomik dan idempoten), voucher, kunjungan, favorit, ubah persetujuan (berversi, sumber `member_pwa`), kirim masukan. Pakai service loyalti, voucher, dan consent yang sudah ada (cari lewat `Explore`); jangan menulis ulang buku poin.

Potongan sesudah peta kode: baca-saja (overview, poin, misi, hadiah, voucher, kunjungan, favorit) lewat `implementer` paralel di berkas terpisah; tukar hadiah dan persetujuan kamu pegang sendiri.

## Kartu
Awal: `ghostex board associate legend-u57q`, `bd update legend-u57q --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Sambungan UI ke API sungguhan: buat kartu terpisah.

## Scope
Boleh: route dan service member di `apps/api`, `packages/shared/src/crm/*` bila kontrak perlu dilengkapi, tes. Jangan: UI web, kampanye CRM, promo, reservasi, delivery.

## Bukti selesai
- Tes gagal-dulu: member hanya melihat datanya sendiri (bukan member lain, bukan tenant lain); tukar hadiah dengan poin kurang ditolak; tukar dua kali dengan kunci idempoten sama memotong poin sekali; dua penukaran bersamaan tidak membuat saldo negatif; persetujuan tersimpan sebagai versi baru dengan sumber `member_pwa`; masukan tervalidasi.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- `tsc` api dan shared lewat `heavy` sekali; eslint + prettier.
- Review (tingkat K): satu `architect`.
- Tulis brief Codex `docs/briefs/289b-second-opinion-member-api.md`, jangan dijalankan.

## Laporan
Sekali di akhir: SHA, migrasi (`when`, prevId) atau tidak ada, bukti, file berubah, kontrak untuk UI, risiko, jumlah subagent dan puncak bersamaan.
