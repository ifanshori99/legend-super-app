# Brief: engineer — reservasi: reschedule staf dan link kelola tamu

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Ikuti juga `~/.agents/team/brief-template.md` bagian bukti dan laporan (versi 14 Nov).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Di akhir: rename cabang ke `ws/reservation-reschedule` dan push tanpa force.

## Tujuan dan kartu
Kartu `legend-9txo` (staf setujui/tolak permintaan reschedule: layar + endpoint) dan `legend-lb3c` (link kelola untuk tamu di email konfirmasi dan pengingat). Link tamu adalah akses tanpa login: token harus acak, kedaluwarsa, hanya untuk reservasi itu, dan tidak membocorkan data tamu lain (test isolasi). Layar staf: ikuti pola layar reservasi yang ada; bila butuh layar baru tanpa mockup, kerjakan backend + kontrak dulu dan catat UI sebagai kartu gate-ui.
Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. Kartu yang ternyata sudah beres di `milestone/m1`: tutup dengan bukti commit. Kriteria: `bd show <id>`.

## Scope
- Boleh diubah: `apps/api/src/routes/reservation.routes.ts`, `apps/api/src/services/reservation-*.ts`, `apps/web/src/features/ws08-reservation/`, template email reservasi, test terkait.
- Jangan disentuh: payroll, payout, finance-exceptions, edge-sync, reports schedule-recipients, ops checklist, platform audit, HRIS cuti, berkas test flake.
- Migrasi: hanya rentang `0563-0564`; cek `node ~/.agents/team/check-journal.mjs` sebelum lapor. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore 2: dibagi per kartu.
- test-writer: test gagal-dulu, dijalankan terhadap base dan dicatat yang merah sebelum implementer menggabung.
- implementer: satu per kartu, file tidak bertumpuk.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="<berkas>" heavy pnpm test` hijau; merah di base tercatat.
- Pra-gate AGENTS.md (prettier, eslint, teks UI bila ada, db:generate kosong, typecheck api + web bila shared berubah, lewat heavy).
- Review: satu subagent architect effort high (akses tamu tanpa login). Temuan nyata dibetulkan.
- Commit, rename, push. Jangan merge.

## Batas kerja ulang (Retro 11)
- typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor ke CTO.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
