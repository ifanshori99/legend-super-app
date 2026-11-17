# 966 Codex S: error bertipe malware scanner + AI purchasing suggestion di SQL

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex gpt-6.1-sol medium. Tingkat S (tanpa uang, akses, migrasi). Review: satu reviewer.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (subagent Codex bawaan, maks 6).
Cabang: worktree-mu dari `origin/milestone/m1` (0c31ff40e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Tanpa migrasi. Kamu tidak menjalankan `bd`: CTO yang memindah kartu.

Kartu:
- legend-bkoim: `MalwareScanner.scan` reject dengan Error polos sehingga upload jadi 500. Tambah rejection bertipe di `core-image.ts`/`core-storage.ts`: file terdeteksi -> 4xx (HttpError, kode jelas), scanner mati -> 5xx/503 bertipe. Aktifkan `it.skip` di `hris-attendance-selfie-bind.test.ts`.
- legend-julap: `ai-purchase-suggestion.service.ts:39` memuat semua pasangan item/lokasi lalu menyaring di memori. Pindahkan filter kekurangan stok ke SQL, pagination dengan limit maks dan urutan stabil (alias endpoint ws06 ikut). Kontrak respons tetap; batas maks divalidasi zod di shared.

Jangan sentuh: `services/ai-tools/`, `ai-action-executors/`, `purchasing-order.service.ts` (milik thread 964), alur pembayaran.

Bukti: test gagal-dulu untuk tiap kartu (unit/integration terarah, `LEGEND_TEST_FILES=... heavy pnpm test`), lalu lint, `heavy pnpm --filter @starter/api typecheck` (shared berubah: juga web), prettier pada file berubah.

Laporan: SHA, cabang, kartu, test (gagal-dulu dan lulus), angka subagent. Lapor sekali di akhir.
