# 930 Port cabang tertahan ke m1: KDS stations, perbaikan 844, zvz (kartu S)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort high. Tidak ada aturan uang/akses baru. Tidak merge ke m1, tidak deploy, tidak force push cabang lama.
Basis: worktree-mu dari `milestone/m1` terbaru. Buat cabang terpisah per sumber:
1. `ws/edge-kds-stations-r2`: bawa 4 commit `origin/milestone/m1..origin/ws/edge-kds-stations` (legend-i78o6, legend-40nvj). Migrasi `device_scanner_status` jadi migrasi sementara baru di atas ujung m1 (0431 atau sesudah ujung terbaru); `db:generate` kosong, snapshot rechain benar.
2. `fix/844-ui-delivery-r2`: bawa 2 commit `origin/milestone/m1..origin/ghostex/5ce165c2` (POS/KDS/tamu 844 + pagination menu delivery).
3. legend-0y8tf: port perbaikan `zvz` ke m1 sesuai `bd show legend-0y8tf` dan catatan di `docs/merge-queue.md` (versi sesudah c3cef7cb4). Boleh satu cabang `fix/0y8tf-zvz-port` atau gabung ke (2) bila filenya sama.
Konflik: ikuti pola m1 terbaru (mock e2e legend-jemae, catalog v3). Jangan mengubah perilaku di luar commit sumber.
Paralel: satu subagent per cabang (file terpisah), test-runner, satu reviewer atas tiap diff.
Bukti per cabang: test area lewat heavy setelah commit terakhir (KDS/edge, delivery, e2e expo/pickup lewat heavy --browser), prettier, eslint, typecheck yang tersentuh sekali.
Laporan: cabang, SHA, migrasi, hasil test, temuan reviewer, angka subagent. Push tiap cabang tanpa force. Komentari kartu. Lapor sekali saat selesai.
