# Brief 118: engineer kecil — bersihkan kartu bd yang sudah selesai di m1

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Tugas ini tidak mengubah kode.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Baca kode di cabang `milestone/m1` (`git show milestone/m1:<path>`, `git grep <pola> milestone/m1`). Folder proyek sedang di cabang lain; jangan checkout.

## Tujuan
`bd ready` berisi ~370 kartu, banyak yang sebenarnya sudah dibangun di m1. Daftar siap harus mencerminkan kerja yang benar-benar tersisa, supaya CTO bisa mengisi slot dengan tepat.

## Tugas
1. Mulai dari kartu ini (dugaan sudah selesai): legend-9by4, legend-rz2r, legend-zy43, legend-rm8i, legend-mf0.4, legend-bjy6, legend-kzn1, legend-44jm, legend-iuvq.
2. Lanjutkan ke semua kartu non-epic dan non-EXT dari `bd ready -n 400`. Bagi per workstream (WS-01 sampai WS-14) ke subagent `Explore` paralel, satu per workstream.
3. Tiap kartu dinilai dengan bukti di m1: kode ada, terpasang (route terdaftar, job dijadwalkan, port di-wire), dan ada test.
   - Lengkap: `bd close <id> --reason "<bukti: berkas:baris dan test>"`.
   - Sebagian: `bd comment <id> "<yang sudah ada, yang kurang>"`, biarkan terbuka.
   - Belum ada: biarkan.
4. Jangan sentuh kartu: legend-q1e0, legend-9be7 (refund promo, sedang dikerjakan), legend-0ogy, legend-dnkm (DOIT, menunggu merge), legend-ddoy, legend-12ku, legend-aor4 (edge, sedang dikerjakan), legend-a7x7, legend-4ryw (provisioning, sedang dikerjakan), legend-9obf, legend-dwrr.
5. Kartu FE (layar) dianggap selesai hanya bila layarnya ada di `apps/web` dan memakai API sungguhan, bukan mock.

## Scope
- Boleh: `bd close`, `bd comment`.
- Jangan: mengubah kode, commit, push, `passes` di `docs/features.json`.

## Bukti selesai
Daftar kartu yang ditutup beserta buktinya, tersimpan di `docs/qa/2026-11-09-bd-stale-cleanup.md` (berkas baru, tidak di-commit).

## Laporan
Jumlah kartu dinilai, ditutup, diberi komentar sebagian, dan tetap terbuka. 10 kartu terbuka paling penting yang benar-benar belum dibangun (id, judul, berkas yang kemungkinan disentuh), untuk gelombang berikut.
