# 926 Rebase e2e 858 ke m1 (kartu S, test saja)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort medium. Tanpa ubah kode produk.
Cabang sumber: `fix/e2e-m1-858` 3272f4dee (e2e PAY-04 refund, legend-y4f3l dkk). Buat cabang baru `fix/e2e-m1-858-r2` dari `milestone/m1` terbaru (7b7cc52df), bawa commit 858 (cherry-pick atau rebase), selesaikan konflik di 3 spec dengan pola mock e2e m1 (legend-jemae). Jangan force push cabang lama.
Bukti: spec yang tersentuh hijau lewat `heavy` (Playwright, satu sekaligus); prettier, eslint pada file berubah; satu reviewer atas diff.
Laporan: cabang, SHA, spec + hasil, angka subagent. Lapor sekali saat selesai.
