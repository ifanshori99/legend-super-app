# Brief: ui-engineer — layar lupa PIN slip gaji lewat WhatsApp masuk (legend-ur82k)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/ur82k-lupa-pin-ui` dari `origin/fix/codex-418-pin` (98966d1b, berisi UI PIN slip gaji yang sudah disetujui founder) di `.worktrees/ur82k`.

## Kartu
`legend-ur82k`. Awal: `ghostex board associate legend-ur82k` + `bd update legend-ur82k --status in_progress`. Lapor: `--status review` + `bd comment`.

## Masukan
- Mockup DISETUJUI founder (Q12): `git show origin/ws/design-pin-inbound` (8e1325db, 10 layar; lihat folder design/mockups di commit itu). Baca satu layar saat membangun layar itu.
- Kontrak API: desain `git show origin/ws/kirimdev-inbound-design:docs/design/whatsapp-inbound-verification.md` §5.2, §6.2 (endpoint `reset-wa`). API sedang dibangun thread lain (kartu legend-9h2oj, cabang ws/9h2oj-wa-reset). Bangun UI terhadap mock handler sesuai kontrak §6.2; jangan menunggu API.
- Keputusan founder: nomor tertaut minimal 3 hari; tanpa WA terverifikasi -> teks "Hubungi HR atau atasan di outlet"; wa.me + QR + polling + PIN baru.

## Pembagian paralel (giliran pertama, satu giliran)
- 1 `Explore` (UI PIN slip gaji yang ada, pola mock handler, pola polling), 1 `test-writer` (e2e mock Playwright + unit hooks, gagal-dulu).
- Lalu `implementer` per kelompok layar (maks 3, file tidak bertumpuk). Satu token heavy per thread.
- Akhir: `ui-auditor` (390 dan 1280, axe) + screenshot semua state ke `docs/qa/ur82k/`.

## Scope
Hanya `apps/web` fitur slip gaji/PIN + mock handler + test. Jangan ubah API.

## Bukti selesai
e2e mock lulus via `heavy`, typecheck web 0, ui-auditor tanpa temuan tersisa, screenshot 390/1280 tiap state (menunggu pesan, berhasil, kedaluwarsa, nomor belum 3 hari, tanpa WA -> HR, PIN baru).

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih. Halaman review founder TIDAK dipublikasikan sendiri: sebut path screenshot di laporan.

## Laporan
Hasil, bukti, sha, temuan ui-auditor, path screenshot. Subagent: total, puncak bersamaan, siapa memegang token heavy.
