# 1150 Klien member minta token QR tukar poin (legend-fmw1u, tingkat S web)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md), ikuti `~/.agents/team/ui-standard.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore klien member + kontrak, test-writer, implementer api/hooks, implementer layar).
Cabang `ws/1150-member-qr-token` dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi. Klaim: `bd update legend-fmw1u --claim`.

Konteks: rute API `POST /member/qr-token` sudah di m1 (930b61c77; body opsional `{orderId, points}`, berlaku 120 detik, sekali pakai). Order `member_qr` di kasir wajib `memberToken` (1059 weexf). Tanpa klien, member tidak bisa tukar poin di kasir.
Tugas: di klien member (PWA/web) yang sudah ada, tampilkan QR token untuk kasir: minta token dari rute itu (dengan `orderId`/`points` bila member memilih tukar poin), hitung mundur 120 detik, tombol minta ulang saat kedaluwarsa, status gagal/offline jelas. Pakai layar member yang sudah ada; bila wajib layar baru, berhenti dan lapor dulu (butuh mockup). Pola `features/<x>/{api,queries,hooks}.ts`. Mock `?mock=` untuk e2e bila pola mock ada.
Tanpa ubah API/server uang. Bila kontrak shared kurang, lapor dulu.
Teks UI baru ke katalog (`node --test tests/text-contract.test.mjs`).
Bukti: test gagal-dulu (vitest web: token diminta, kedaluwarsa, minta ulang, gagal). Prettier, eslint. Typecheck web sekali lewat `heavy`. `ui-auditor` sekali, screenshot 390/1280 lewat `heavy`.
Laporan: head SHA, kartu selesai, risiko, path screenshot. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
