# Brief: engineer (Codex) — M3 layar penerimaan, kas kecil, waste memakai unggah nyata (legend-uaoli)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `ws/media-web-storage-client` (513f7b7fc, M1). Cabang akhir: `ws/media-screens-upload`.

## Tujuan
Kartu M3 di desain (`git show origin/docs/media-transport-design:docs/design/media-transport.md`). Layar penerimaan barang, pembelian kas kecil, dan waste log sekarang membuat id media lokal (data URL). Ganti dengan unggah nyata memakai client M1: `uploadStorageFile({ ...metadata, file: await normalizeImageFile(file) })` dengan purpose yang benar (`goods_receipt`, `petty_purchase`, `waste_log`), dan tampilkan foto lewat `useStorageObjectUrl(id, variant)`. Keadaan gagal (503 penyimpanan atau pemindai, offline) harus jelas di layar dan tidak menyimpan id palsu.

## Kartu (agent Codex tidak menjalankan bd)
legend-uaoli (M3, tingkat S). Backend penerimaan barang sedang diperbaiki terpisah (M2: foto ditautkan di transaksi create); jangan ubah apps/api.

## Scope
- Boleh: komponen photo-field dan tiga layar itu di apps/web, mock/test e2e terkait, katalog teks.
- Jangan: apps/api, features/storage (milik M1; bila butuh perubahan kecil, catat di laporan), payout.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) photo-field.tsx dan pemakaiannya di tiga layar; (b) mock media lokal di e2e/test yang harus diganti.
- test-writer: test gagal-dulu: tiga layar memanggil unggah dengan purpose benar; gagal 503 tidak menyimpan id; foto tampil lewat signed URL.
- implementer: satu per layar (3), file tidak bertumpuk.
- Pemegang token heavy: satu subagent.

## Bukti selesai
- Test terarah web lewat `heavy`; e2e mock layar terkait sekali di akhir lewat `heavy` (spesifikasi yang gagal: jalankan sekali di base dulu sebelum diulang).
- Pra-gate AGENTS.md: prettier, eslint, text-contract, typecheck web sekali lewat `heavy`.
- Screenshot 390 dan 1280 satu layar (penerimaan) dengan foto terunggah.

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Satu watcher per job.

## Sebelum melapor
Commit hanya file scope, rename cabang `ghostex/...` ke `ws/media-screens-upload`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cabang akhir, test gagal-dulu, path screenshot, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
