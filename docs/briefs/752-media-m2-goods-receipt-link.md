# Brief: engineer — M2 penerimaan barang menautkan foto dengan benar (legend-9h4qh, AKSES)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `milestone/m1`. Cabang akhir: `fix/goods-receipt-photo-link`.

## Tujuan
Kartu M2 di `docs/design/media-transport.md` (ambil: `git show origin/docs/media-transport-design:docs/design/media-transport.md`). Celah: service penerimaan barang hanya cek outlet dan purpose, tidak memanggil `linkStorageObjectSource`, dan tidak cek pengunggah. Akibatnya foto milik orang lain atau foto `cash_deposit` bisa ditempel, dan tautan audit ke penerimaan hilang. Perbaiki: tautkan foto di dalam transaksi create, tolak foto purpose lain, foto pengguna lain, atau foto yang sudah tertaut. Tambah pembersihan foto tak tertaut lebih dari 24 jam. Contoh benar: alur kas kecil (petty purchase).

## Kartu
`legend-9h4qh`. Di awal: `bd update legend-9h4qh --status in_progress` (lewati `ghostex board associate` bila error multi-board). Saat melapor: `bd update legend-9h4qh --status review` dan `bd comment legend-9h4qh "<ringkasan>"`.

## Scope
- Boleh: service/route penerimaan barang di apps/api, job pembersihan storage, test di apps/api/src/test/.
- Jangan: apps/web, payout, alur kas kecil (kecuali dipakai sebagai contoh), migrasi (tidak ada nomor; bila ternyata butuh, berhenti dan tanya CTO).

## Pembagian paralel (giliran pertama)
- Explore (2): (a) service penerimaan barang dan titik validasi foto; (b) pola linkStorageObjectSource di kas kecil dan job pembersihan yang ada.
- test-writer: test gagal-dulu: foto pengunggah lain ditolak, foto purpose cash_deposit ditolak, foto sudah tertaut ditolak, create sukses menautkan foto (source terisi), rollback create tidak meninggalkan tautan, pembersihan hanya menghapus yang tak tertaut > 24 jam dan milik tenant yang benar.
- implementer: (1) service penerimaan, (2) job pembersihan.
- Pemegang token heavy: satu subagent.
- Review: satu subagent `architect` effort high (akses) pada diff akhir.

## Bukti selesai
- `LEGEND_TEST_FILES="<file test>" heavy pnpm test` hijau; merah di base tercatat.
- Pra-gate AGENTS.md: prettier, eslint, typecheck api lewat `heavy`.

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit hanya file scope, rename cabang ke `fix/goods-receipt-photo-link`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cabang akhir, test gagal-dulu, temuan architect, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
