# Brief: engineer (Codex) — M1 web storage client (legend-avf8m)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `milestone/m1`. Cabang akhir: `ws/media-web-storage-client`.

## Tujuan
Kartu M1 di desain `docs/design/media-transport.md` (ambil: `git show origin/docs/media-transport-design:docs/design/media-transport.md`). Bangun client storage web di `apps/web/src/features/storage/*` (api, queries, hooks), helper unggah ke `POST /api/storage/uploads`, pengecilan gambar di perangkat (JPEG, sisi terpanjang 2560 px, < 5 MiB), dan `useStorageObjectUrl` untuk signed URL (`POST /api/storage/objects/:objectId/signed-url`, 300 detik). Pindahkan unggah selfie ke client ini. Jangan wiring layar penerimaan/kas kecil/waste (itu M3).

## Kartu (agent Codex tidak menjalankan bd)
legend-avf8m (M1, tingkat S).

## Scope
- Boleh: `apps/web/src/features/storage/**`, pemakai selfie yang dipindah, test web terkait.
- Jangan: apps/api, payout, migrasi, layar penerimaan/kas kecil/waste.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) endpoint storage API yang ada di m1 dan kontrak shared-nya; (b) unggah selfie sekarang dan pola features/<x>/{api,queries,hooks}.
- test-writer: test gagal-dulu untuk helper unggah (pengecilan, batas ukuran, error 503 scanner) dan hook signed URL (refresh sebelum kedaluwarsa).
- implementer: (1) features/storage, (2) pindah selfie.
- Pemegang token heavy: satu subagent.

## Bukti selesai
- Test terarah web lewat `heavy` (sesuaikan runner web).
- Pra-gate AGENTS.md: prettier, eslint, teks UI baru ke katalog (`node --test tests/text-contract.test.mjs`), typecheck web sekali lewat `heavy`.

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit hanya file scope, rename cabang `ghostex/...` ke `ws/media-web-storage-client`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cabang akhir, test gagal-dulu merah di base, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
