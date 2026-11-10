# Brief: engineer — login WhatsApp nomor tersamar (w8dfz.1) + job pembersihan data WA (w8dfz.2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua worktree, keduanya dari `origin/ws/lgfru-wa-proof` (9b41cc6d, kartu A sudah di sana):
- `ws/w8dfz1-wa-masked` di `.worktrees/w8dfz1`.
- `ws/w8dfz2-wa-retention` di `.worktrees/w8dfz2`.
Thread lain sedang mengerjakan kartu B (reset PIN, cabang ws/9h2oj-wa-reset) dan legend-5opkl (isolasi test identitas) di area yang sama: jangan ubah file reset PIN payslip atau file test identitas yang sudah ada kecuali menambah kasus baru di file baru.

## Kartu
`legend-w8dfz.1`, `legend-w8dfz.2`. Awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan
- w8dfz.1 (P1, akses): sebelum sesi login WhatsApp pelanggan dipakai, web menampilkan nomor tersamar + tombol "Bukan saya". Langkah 1: cek apakah sudah ada (API + web). Bila sudah ada: tutup kartu dengan bukti file:baris. Bila belum: API dulu (data nomor tersamar di respons poll/selesai, aksi "Bukan saya" membatalkan tantangan/sesi), test gagal-dulu. UI baru TIDAK dibangun sebelum gerbang founder: bila butuh layar/elemen baru, berhenti setelah API dan tulis usulan UI (teks + posisi) di laporan; CTO bawa ke founder.
- w8dfz.2 (P2): job pembersihan: log pesan WhatsApp masuk 90 hari, tantangan selesai 30 hari, audit 2 tahun (desain `git show origin/ws/kirimdev-inbound-design:docs/design/whatsapp-inbound-verification.md` §10). Pakai pola worker/job yang sudah ada di repo (Explore cari). Hapus bertahap (batch), idempoten, per tenant aman RLS. Jangan hapus audit yang < 2 tahun.

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (satu per kartu) + 2 `test-writer` (gagal-dulu; vitest backend termasuk lingkup test-writer).
- Lalu 1 `implementer` per kartu. Satu token heavy per thread.
- Review: w8dfz.1 tingkat K (akses) -> satu subagent `architect` effort high; w8dfz.2 tingkat K (hapus data pribadi) -> `architect` effort high. Bisa satu architect untuk kedua diff.

## Scope
Hanya file kartu ini + test baru. Migrasi hanya bila wajib (index untuk job): nomor sementara 0274; jangan ubah migrasi lain.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus per kartu; `heavy pnpm --filter @starter/api typecheck` 0; gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push tiap cabang. Hapus worktree yang bersih.

## Laporan
Per kartu: hasil, bukti, sha, temuan review, usulan UI (bila ada). Subagent: total, puncak bersamaan, siapa memegang token heavy.
