# Brief: merge train batch73

Lanjutan batch72 (m1 42f349c36). Aturan sama seperti brief 892/724 (bagian "Wajib"), termasuk test pasangan di fast set dan run penuh di latar dengan Monitor. Maks 7 merge. Jangan merge ke `main`, jangan deploy.

## Cabang (urut)
1. `fix/payout-failed-correction-891` 8f7c91126 (uang, penghalang rilis; sudah memuat `fix/payout-area-final-888` 036979292 dan m1 9ad4dcee7). Migrasi sementara 0631-0636 dinomori ulang setelah 0388. Kartu: w5yx6, v6gtp, wcd24, 8vcsg, mejr2. Second opinion-nya sudah jalan; perbaikannya (`fix/payout-so895-897`) menyusul di batch berikut, tidak menahan batch ini.
2. `ui/payout-password-stepup-890` 9aa50713b (web, legend-caobb; dasar 888 bddf9bf6c).
3. `fix/edge-selfie-scanner` 4c0b5a6c9 (legend-xn214): pasang ulang resolusi konflikmu (helper `createSelfieUploadScanner` meneruskan `context` ke `scan` dan melempar ulang `SCANNER_OVERLOADED`).
4. `ws/edge-node-domain-rate` (memuat `ws/tenant-domain-audit`).
5. `ws/metrics-daily-backfill`.
6-7. Berikutnya dari `docs/merge-queue.md`, uang dan penghalang rilis dulu; lewati yang DITAHAN (QRIS hold).

## Laporan
Seperti batch72: SHA m1, cabang masuk dengan id kartunya, migrasi dan nomor barunya, hasil gate dan run penuh (exit code dari log), flake baru berkartu. Perbarui `docs/merge-queue.md` (hapus yang mendarat).
