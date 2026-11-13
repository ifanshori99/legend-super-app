# Brief: engineer — kebenaran poin loyalty (uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Ikuti juga `~/.agents/team/brief-template.md` bagian bukti dan laporan (versi 14 Nov).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Di akhir: rename cabang ke `ws/loyalty-points-money` dan push tanpa force.

## Tujuan dan kartu
Kartu `legend-29shf` (redeem grant kedaluwarsa yang belum disapu), `legend-4frkf` (refund setelah grant kedaluwarsa mendebit saldo grant lain), `legend-st2i1` (balik bonus referral saat void/refund penuh), `legend-90na8` (tukar token klaim split-bill jadi poin member; c69162473 hanya sebagian). Aturan founder: tidak ada pihak dibayar lebih dan outlet tidak rugi; buktikan dengan test (poin tidak pernah tercipta ganda, saldo tidak negatif, idempoten saat retry/konkuren). Bila ragu, pilih aturan yang membatasi dan lapor keputusannya ke CTO.
Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. Kartu yang ternyata sudah beres di `milestone/m1`: tutup dengan bukti commit. Kriteria: `bd show <id>`.

## Scope
- Boleh diubah: service/route/test loyalty, referral, klaim split-bill, validator terkait.
- Jangan disentuh: payroll, payout, finance-exceptions, edge-sync, reports schedule-recipients, ops checklist, platform audit, HRIS cuti, berkas test flake.
- Migrasi: hanya rentang `0555-0556`; cek `node ~/.agents/team/check-journal.mjs` sebelum lapor. Jangan hapus volume Docker apa pun.

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
