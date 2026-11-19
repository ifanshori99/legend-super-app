# 1185 Lanjutan 1170: flake e2e bz3hj + tutup h2wvx (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Thread Codex 1170 berhenti (kuota Codex habis). Lanjutkan di folder yang SAMA, jangan buat worktree baru:
`/Users/ifanshori99/Projects/legend super app/legend-75927c0c`, cabang `ws/1170-flake-higiene` (sudah di-push: oqs0y 38478aac4, 3g69v 95f4045b1).
Brief asli: `docs/briefs/1170-flake-e2e-higiene-test.md` (batas dan bukti tetap berlaku). Tingkat S, tanpa migrasi.

## Sisa
1. `legend-bz3hj`: perubahan staged/belum commit di `e2e/legend-cz9g.mock.spec.ts`, `e2e/legend-kmndq.mock.spec.ts`, `tests/e2e-state-hydration.test.mjs`, `tests/vitest-serial.test.mjs`. Periksa, selesaikan (tunggu keadaan, bukan waktu tetap), bukti e2e terarah lewat `heavy` (beberapa run), commit.
2. `legend-h2wvx`: run penuh 2 worker sudah dilakukan Codex dan MERAH (~16k lulus, 11 gagal di 7 file, termasuk `payroll-policy-api.test.ts` pagination + isolasi tenant). Sesuai brief: kembalikan `apps/api/vitest.config.ts` ke 1 worker (jangan run penuh lagi), tulis daftar file yang bertabrakan + dugaan sebab ke `docs/qa/1170-two-worker-collisions.md`, buat bead lanjutan per kelompok sebab (`bd create`). Kartu h2wvx tetap open dengan catatan.
Tutup `legend-3g69v`, `legend-oqs0y`, `legend-bz3hj` dengan `bd close` sesudah bukti.

## Bukti dan laporan
Prettier + eslint file berubah. Reviewer sonnet satu kali di akhir. Commit dan push. Laporan: SHA, kartu ditutup, bead baru, jumlah subagent dan puncak. Antrean `heavy` panjang: tunggu dengan Bash run_in_background satu notifikasi, jangan monitor heartbeat.
