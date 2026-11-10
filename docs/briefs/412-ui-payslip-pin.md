# Brief: ui-engineer — layar PIN slip gaji (legend-ilzrj) + sisa percobaan di API

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Giliran pertama: Explore (kontrak API + pola layar HRIS web), test-writer, dan satu implementer per layar/berkas, semua sekaligus. Edit sendiri dibatasi hook: serahkan edit ke implementer.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/payslip-pin-ui`, cabang `ws/payslip-pin-ui`, dari `ws/hris-pii-pin` (8305fdc3). Merge `design/payslip-pin` (44c3c155) untuk mockup. Lalu `pnpm worktree:setup`.

## Mockup (disetujui founder)
`design/mockups/payslip-pin/` (README + PNG 390/1280). Baca satu PNG saat membangun layar itu.

## Keputusan founder
- PIN dibuat karyawan sendiri; HR hanya reset (tidak melihat atau mengatur PIN).
- Lupa PIN: teks "Hubungi HR atau atasan di outlet", tanpa nomor.
- Reset lewat kode WhatsApp ikut dibangun (adapter dikerjakan thread lain, `legend-qih2m`); bila API 503, tampilkan keadaan "belum tersedia" yang jelas.

## Tujuan
1. BE kecil (implementer): respons 403 `PAYSLIP_PIN_INVALID` mengembalikan `remainingAttempts`, 423 mengembalikan `lockedUntil`. Kontrak di `packages/shared`, test API gagal-dulu.
2. Web: semua layar mockup karyawan (buat PIN, buka slip, salah PIN dengan sisa percobaan, terkunci, lupa PIN, ubah PIN, kode WhatsApp termasuk 429/503) dan tombol reset PIN di layar HR dengan konfirmasi. Kosong, memuat, error. Nominal tersembunyi sebelum PIN benar.

## Kartu
`legend-ilzrj`. Awal: `ghostex board associate legend-ilzrj`, `bd update legend-ilzrj --status in_progress`. Lapor: `--status review` + `bd comment`.

## Bukti selesai
Test unit/integration gagal-dulu (logic layar + API remainingAttempts). tsc + eslint + prettier via `heavy`. Satu e2e mock di akhir. Screenshot tiap layar 390 dan 1280 (path di laporan). `ui-auditor` atas semua layar, lalu satu `reviewer` sonnet; temuan nyata dibetulkan. Hasil ini masuk gerbang review UI founder.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis. Saat menunggu heavy, jalankan review/test paralel. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil, bukti, path screenshot, subagent dan puncak, risiko.
