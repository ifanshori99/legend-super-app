# 526 Tambahan untuk Codex sebagai engineer pengganti (founder Q64, sampai 00:40 12 Nov)

- Kamu Codex, menggantikan engineer Claude karena kuota Claude habis. Ikuti ~/.agents/team/roles/engineer.md, kecuali: subagent Codex bawaan maks 6 (bukan implementer/test-writer/architect Claude).
- Brief di bawah menyebut thread Claude lama (G48kv/G92j5) atau review architect: abaikan nama thread itu, kerjakan sendiri di worktree yang disebut. Review architect Claude dijadwalkan CTO setelah 00:45; kamu cukup tulis test gagal-dulu, fix, test terarah, tsc.
- Build/test/tsc wajib lewat `heavy` (test terarah: `LEGEND_TEST_FILES="..." heavy pnpm test` dari root worktree). Jangan jalankan `pnpm test` penuh.
- Uang: buktikan dengan test bahwa tidak ada pihak dibayar lebih dan outlet tidak rugi.
- Selesai: commit + push ke cabang kerja (tanpa --force). Laporan akhir: hash, test + hasil, angka subagent, hal yang belum terverifikasi. Bila belum selesai saat 00:40: commit WIP, push, laporkan sisa pekerjaan.

---
