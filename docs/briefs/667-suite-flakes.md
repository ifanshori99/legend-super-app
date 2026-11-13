# Brief: engineer — flake test di suite penuh (non-HRIS)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree baru dari `milestone/m1`, cabang `ws/suite-flakes`.

## Tujuan
Hilangkan merah palsu di suite penuh yang memperlambat merge train. Hanya ubah test dan helper test, kecuali akar masalah terbukti di kode produksi (lapor dulu bila itu menyentuh uang).

## Kartu
`legend-gnm6y`, `legend-0lyzf`, `legend-y9uop`, `legend-u7ozi`, `legend-60psh`, `legend-whg2`, `legend-9uks`. Jangan kerjakan `legend-puc57` (sedang dibetulkan merge train batch61) dan `legend-dyws`. Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. Kartu yang sudah beres di `milestone/m1`: tutup dengan bukti commit (0lyzf sebagian dibetulkan `399e99b0b`).

## Masukan
- `bd show <id>` tiap kartu.
- Pola umum: `vi.waitFor` default 1 s di bawah beban, jam DB vs API, fixture/tenant bersama, hitungan global. Arah: tunggu kondisi dengan timeout cukup, waktu dari satu sumber, tenant per suite.
- Hindari bentrok dengan batch62: sebelum mengedit, `git diff --name-only milestone/m1 origin/ws/finance-exceptions` dan `origin/ws/reports-ops-backend`; file test yang muncul di sana jangan disentuh (catat kartunya sebagai tertunda).
- `legend-y9uop` dan `legend-60psh` menyentuh test payroll/pembayaran: hanya ubah setup/jam test, bukan logika uang.

## Scope
- Boleh diubah: berkas test dan helper di `apps/api/src/test/` untuk kartu di atas.
- Jangan disentuh: kode produksi accounting, payroll, payout, edge (kecuali akar terbukti dan dilaporkan dulu). Tanpa migrasi. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore (2): edge (gnm6y, 9uks, whg2); lainnya (0lyzf, y9uop, u7ozi, 60psh).
- implementer: satu per kartu/berkas test, maks 7, tidak bertumpuk.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- Tiap berkas yang diubah: `LEGEND_TEST_FILES="<berkas>" heavy pnpm test` hijau 3 kali berturut; catat merah sebelum fix bila bisa direproduksi (di bawah beban: jalankan dua berkas bersamaan).
- Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat heavy).
- Satu `reviewer` sonnet atas diff.
- Commit lokal, push ke `ws/suite-flakes` (tanpa force). Jangan merge.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
