# Brief: ui-engineer (Claude Sonnet) — bangun layar Pengaturan AI (legend-nnufz)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. UI mengikuti `~/.agents/team/ui-standard.md`.

## Sumber
- Mockup disetujui founder (Q91): `git show origin/design/ai-settings:design/mockups/ai/ai-settings.html` + README dan PNG di folder yang sama (baca hanya PNG yang perlu). Jangan commit folder mockup.
- Kontrak API sedang dibangun thread lain di `origin/ws/ai-login-autodetect` (kartu legend-39d.8, legend-z83k): kemampuan model terdeteksi + override, level thinking, device code (mulai, polling, cabut), persetujuan risiko, kill switch. Baca schema shared di cabang itu (`git show`), bangun UI terhadap mock handler sesuai kontrak; jangan menunggu API, jangan mengubah cabang itu.
- Provider kustom yang sudah ada di m1 (legend-dwrr): pakai hook/endpoint yang ada.

## Kerja
Cabang `ui/ai-settings` basis `milestone/m1`. Halaman di area Kelola (lihat `docs/frontend.md` "Where to put a new screen"), guard `roleHasPermission`. Tujuh keadaan sesuai mockup. Kunci API tidak pernah ditampilkan ulang (4 karakter akhir saja). Teks baru masuk katalog teks.
Paralel: Explore (layar Kelola yang ada + hook provider AI) → 2 implementer (panel login ChatGPT | panel model kustom + anggaran) → ui-auditor di akhir.

## Bukti selesai
- Screenshot 1280 dan 390 tiap keadaan, typecheck web lewat heavy, pra-gate AGENTS.md hijau.
- Commit + push `ui/ai-settings` tanpa --force. Jangan merge. Lapor file, daftar keadaan, bagian yang masih memakai mock, angka subagent.
