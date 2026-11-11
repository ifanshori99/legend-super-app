# 510 Codex engineer: perkuat test token basi /verify (legend-or2pi, izin founder Q55)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. Kamu Codex: jangan jalankan `bd`.
Worktree sudah ada: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/sec-small (cabang ws/sec-small, 9f001ed6). Pastikan bersih dan sejajar origin dulu; ada perubahan belum di-commit: berhenti dan lapor.

Temuan second-opinion: apps/api/src/test/device-token-stale-verify-clock.test.ts:451 memakai DOMAIN_HOST sehingga 401 datang dari guard lama `source !== "device"`, bukan dari cek registry (`token_issued_at`). Kontrol positif baris 455 tanpa Host. Test lolos walau cek registry dibuang.
Tugas: ubah test saja (kode produksi tidak diubah) supaya kontrol positif dan negatif memakai Host/source sama, dan 401 hanya bisa datang dari cek registry. Bukti gagal-dulu: buang sementara cek registry di route /staff-pins/verify, test harus merah; pasang lagi, hijau. Jangan commit pembalikan itu.
Gate: test file itu + edge-pin-proof + device-token-rotation-replay lewat `heavy`, eslint/prettier. Commit, push ws/sec-small (tanpa --force).
Laporan: commit, bukti gagal-dulu, hasil gate, angka subagent.
