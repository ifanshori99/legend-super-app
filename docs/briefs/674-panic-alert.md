# Brief: engineer — tombol darurat WS-02 (relay LAN)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Ikuti juga `~/.agents/team/brief-template.md` bagian bukti dan laporan (versi 14 Nov).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Di akhir: rename cabang ke `ws/panic-alert` dan push tanpa force.

## Tujuan dan kartu
Kartu `legend-bod` (relay tombol darurat di LAN outlet, <= 5 detik ke staf bertugas, tetap jalan tanpa internet), `legend-kmjax` (outbox sinkron cloud + fallback web-push), `legend-kpzmi` (banner panik staf lewat websocket LAN). Desain yang sudah ada: `docs/design/edge-cloud-failover.md` dan brief `docs/briefs/565-edge-emergency.md` bila relevan. Sebelum mengedit: `git diff --name-only milestone/m1 origin/ws/finance-exceptions`; berkas edge-sync yang muncul di sana jangan disentuh (kmjax bisa tertunda, catat).
Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. Kartu yang ternyata sudah beres di `milestone/m1`: tutup dengan bukti commit. Kriteria: `bd show <id>`.

## Scope
- Boleh diubah: modul darurat edge/cloud, outbox darurat, web-push, banner klien POS/KDS, test terkait. UI banner baru: ikuti mockup bila ada; bila tidak ada mockup, hanya backend + kontrak, catat UI sebagai kartu gate-ui.
- Jangan disentuh: payroll, payout, finance-exceptions, edge-sync, reports schedule-recipients, ops checklist, platform audit, HRIS cuti, berkas test flake.
- Migrasi: hanya rentang `0559-0560`; cek `node ~/.agents/team/check-journal.mjs` sebelum lapor. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore 2: dibagi per kartu.
- test-writer: test gagal-dulu, dijalankan terhadap base dan dicatat yang merah sebelum implementer menggabung.
- implementer: satu per kartu, file tidak bertumpuk.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="<berkas>" heavy pnpm test` hijau; merah di base tercatat.
- Pra-gate AGENTS.md (prettier, eslint, teks UI bila ada, db:generate kosong, typecheck api + web bila shared berubah, lewat heavy).
- Review: satu reviewer sonnet (akses lintas outlet: architect effort high). Temuan nyata dibetulkan.
- Commit, rename, push. Jangan merge.

## Batas kerja ulang (Retro 11)
- typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor ke CTO.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
