# Brief: engineer — celah jurnal otomatis GL (uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Ikuti juga `~/.agents/team/brief-template.md` bagian bukti dan laporan (versi 14 Nov).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Di akhir: rename cabang ke `ws/auto-journal-gaps` dan push tanpa force.

## Tujuan dan kartu
Kartu `legend-2jyr` (refund gateway `order.refunded` dipecah per intent), `legend-27mt` (payout/refund uang yang diterima sebelum auto-journal tersambung), `legend-89pn` (kas keluar/setor POS `cash_movement.recorded` belum punya aturan posting), `legend-tgb3` (jurnal GL inventori saat PERIOD_CLOSED). Cek dulu `legend-3a5m` (mungkin sudah beres di abb920e45): bila ya, tutup dengan bukti. Aturan founder: jurnal seimbang, idempoten (retry/konkuren tidak menjurnal ganda), tidak ada pihak dibayar lebih dan outlet tidak rugi; buktikan dengan test. Bila ragu, pilih aturan yang membatasi dan lapor ke CTO. Sebelum mengedit: `git diff --name-only milestone/m1 origin/ws/finance-exceptions`; berkas payroll/payout di sana jangan disentuh.
Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. Kartu yang ternyata sudah beres di `milestone/m1`: tutup dengan bukti commit. Kriteria: `bd show <id>`.

## Scope
- Boleh diubah: aturan auto-journal (cari `git grep -n 9pz9`), `apps/api/src/services/accounting-journal.service.ts`, `accounting-shared.ts`, `accounting-period.service.ts`, `order-payment-consumers.ts`, test terkait.
- Jangan disentuh: payroll, payout, finance-exceptions, edge-sync, reports schedule-recipients, ops checklist, platform audit, HRIS cuti, berkas test flake.
- Migrasi: hanya rentang `0561-0562 (backfill data = tingkat K, lapor dulu)`; cek `node ~/.agents/team/check-journal.mjs` sebelum lapor. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore 2: dibagi per kartu.
- test-writer: test gagal-dulu, dijalankan terhadap base dan dicatat yang merah sebelum implementer menggabung.
- implementer: satu per kartu, file tidak bertumpuk.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="<berkas>" heavy pnpm test` hijau; merah di base tercatat.
- Pra-gate AGENTS.md (prettier, eslint, teks UI bila ada, db:generate kosong, typecheck api + web bila shared berubah, lewat heavy).
- Review: satu subagent architect effort xhigh (uang). Temuan nyata dibetulkan.
- Commit, rename, push. Jangan merge.

## Batas kerja ulang (Retro 11)
- typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor ke CTO.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
