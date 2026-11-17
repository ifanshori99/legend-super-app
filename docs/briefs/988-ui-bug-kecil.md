# 988 UI bug kecil: /masuk 320px, toaster ponsel, header _ops dan format uang, hydration payroll

Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md). Sonnet 5.5 high (tugas kecil). Ikuti `~/.agents/team/ui-standard.md`. Review: satu ui-auditor + reviewer.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1b0fd2a9e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Tanpa migrasi.

Kartu (`bd show <id>`; claim dulu):
- legend-rxida: halaman /masuk melebar 361px di layar 320px (scroll horizontal).
- legend-5tai0: toaster global menutupi konten/sheet di ponsel.
- legend-r5mf1: UI bersama: tinggi header `_ops` di 390, format uang `Rp38.000` tanpa spasi, kontras border tema.
- legend-v99yu: hydration warning `<div>` di dalam `<p>` di halaman pengaturan payroll.

Jangan sentuh: logika API, alur pembayaran, layar baru. Bug fix saja, tanpa perubahan desain di luar kartu.

Bukti: screenshot sebelum/sesudah di 320, 390, dan 1280 (light+dark) lewat `heavy` (browser satu sekaligus), test unit/komponen bila ada logika (format uang), `node --test tests/text-contract.test.mjs` bila teks berubah.

Paralel: satu implementer per kartu (file terpisah; r5mf1 format uang dulu bila dipakai kartu lain) + ui-auditor dan reviewer bersamaan di akhir. Gate (#9): lint, typecheck web, test terarah web terkait, prettier. Satu token heavy per thread. Jangan jalankan `pnpm check`/`pnpm test` penuh atau e2e penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal (tanpa tick).

Laporan: SHA, kartu, path screenshot, test, temuan ui-auditor/reviewer, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
