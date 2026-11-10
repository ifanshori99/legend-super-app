# Brief: ui-engineer — kartu konfirmasi login WhatsApp pelanggan (legend-kmndq)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/kmndq-wa-login-confirm` dari `origin/ws/w8dfz1-wa-masked` (b5956fdb, API nomor tersamar + confirm/cancel sudah ada) di `.worktrees/kmndq`.

## Kartu
`legend-kmndq` (`bd show legend-kmndq`). Awal: `ghostex board associate legend-kmndq` + `bd update legend-kmndq --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan (alur disetujui founder W10 Q24)
Login WhatsApp pelanggan di web: setelah status poll `awaitingConfirmation`, tampil kartu "Pesan diterima dari +62 ****7890. Masuk sebagai nomor ini?" + tombol utama "Ya, masuk" (confirm) dan sekunder "Bukan saya" (cancel -> kembali ke awal dengan pesan jelas). Klien membuat tantangan dengan `requireConfirm: true`. Pakai endpoint yang sudah ada di basis (Explore cari route + DTO di `packages/shared`). State: menunggu pesan, perlu konfirmasi, berhasil, dibatalkan, kedaluwarsa, gagal jaringan. Ikuti pola layar login pelanggan yang ada.

## Pembagian paralel (giliran pertama, satu giliran)
- 1 `Explore` (layar login WA pelanggan + hooks poll + API confirm/cancel), 1 `test-writer` (e2e mock Playwright + unit hook, gagal-dulu).
- Lalu `implementer` (maks 2, file tidak bertumpuk). Satu token heavy per thread.
- Akhir: `ui-auditor` (390 dan 1280, axe) + screenshot tiap state ke `docs/qa/kmndq/`.

## Scope
Hanya `apps/web` login pelanggan + test. Jangan ubah API (bila API kurang: berhenti, lapor apa yang kurang). Jangan sentuh layar lupa PIN slip gaji (thread lain).

## Bukti selesai
e2e via `heavy` lulus, `heavy pnpm --filter @starter/web typecheck` 0, ui-auditor tanpa temuan tersisa, screenshot 390/1280 tiap state.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih. Halaman review founder TIDAK dipublikasikan sendiri: sebut path screenshot.

## Laporan
Hasil, bukti, sha, temuan ui-auditor, path screenshot. Subagent: total, puncak bersamaan, pemegang token heavy.
