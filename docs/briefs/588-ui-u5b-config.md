# Brief: ui-engineer (Claude Opus) — U5b 12 layar konfigurasi

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. UI mengikuti `~/.agents/team/ui-standard.md`.

## Konteks
`docs/briefs/539-u-areas.md` (baris U5): U5b = 12 layar konfigurasi (mockup 496, wwyyk, 498; `split-claim-wwyyk.html`), mockup disetujui founder. Sebagian layar konfigurasi mungkin sudah masuk m1 lewat `ws/ui-bo-config` (brief 505, `docs/briefs/sub-ui-bo-config*.md`).

## Langkah
1. Explore dulu: daftar 12 layar U5b dari mockup di `design/mockups/` (grep 496, wwyyk, 498), lalu cocokkan dengan route yang sudah ada di `apps/web/src/routes/` di `milestone/m1`. Bangun hanya yang belum ada atau belum sesuai mockup. Tulis daftar hasil cocok ke `docs/briefs/sub-u5b-gap.md`.
2. Bangun layar yang kurang di cabang `ui/tenant-config` (basis `milestone/m1`), satu implementer per layar (file terpisah), memakai hook API yang ada atau mock handler sesuai kontrak shared bila API belum ada.
3. Satu subagent ui-auditor di akhir.

## Batas
Jangan menyentuh API uang/auth. Teks UI baru didaftarkan ke katalog (pra-gate AGENTS.md). Jangan merge, jangan deploy.

## Bukti selesai
- Screenshot 1280 dan 390 tiap layar baru (`ghostex visual check` atau Playwright lewat heavy), typecheck web lewat heavy, pra-gate hijau.
- Commit + push `ui/tenant-config` tanpa --force. Lapor daftar layar (sudah ada / dibangun / tertunda), angka subagent.
