# Brief: engineer — perbaikan temuan second opinion payout (2 P1 + 1 P2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri. Base: ujung rantai payout yang memuat semua cabang payout antre (`ws/payout-api-gaps`, `ws/payout-followups`, `ws/payout-approval-followups`, `fix/payout-approval-confirm-binding`, `ghostex/pemindai-bersama-bukti-payout-m6`). Tentukan dengan `git merge-base --is-ancestor`; bila tidak ada satu ujung yang memuat semua, base dari cabang yang memuat `payroll-payout-manual.service.ts` dan `payroll-payout-gl.service.ts` terbaru, dan catat cabang induknya di laporan. Cabang baru: `fix/payout-second-opinion-870`.

## Tujuan
Tutup tiga temuan di `docs/qa/second-opinion-payout.md` (baca seluruhnya; ada skenario gagal, berkas:baris, dan usul test). Aturan founder: jangan sampai rugi. Tiap perbaikan dibuktikan test bahwa tidak ada pihak dibayar lebih atau dicatat bayar tanpa uang kembali, dan GL cocok dengan uang yang benar-benar bergerak.

## Kartu
`legend-2aspe` (P1 GL settle hilang), `legend-yjbjb` (P1 ekspor bank lama melewati approval), `legend-w3691` (P2 bukti return dipakai ulang). Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` untuk ketiganya. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`.

## Keputusan CTO (sudah diambil, jangan ditanyakan ulang)
- 2aspe: bila akuntansi aktif dan jurnal lock belum ada, settlement disimpan tertunda (bukan `settle_skipped` final) dan diselesaikan idempoten saat jurnal `payroll.locked` diposting. `settle_skipped` final hanya bila payroll memang dikunci tanpa akuntansi. Tanpa jurnal ganda.
- yjbjb: pilih aturan yang membatasi. Pembuatan berkas transfer bank lewat endpoint lama ditolak untuk run yang belum punya batch bank yang disetujui; ekspor pembayaran hanya lewat batch payout yang disetujui (binding sumber/hash + step-up). Unduhan arsip berkas lama yang sudah dibuat tetap boleh. Test lama `payroll-payout-manual.test.ts:1512` disesuaikan ke kontrak baru; jelaskan perubahannya di laporan.
- w3691: bukti return diikat ke satu operasi return (himpunan item + total dana), dikonsumsi atomik; pemakaian bukti yang sama untuk operasi return lain ditolak. Satu bukti untuk beberapa item dalam satu operasi yang sama tetap sah. Jangan memakai constraint satu key per item.

## Scope
- Boleh diubah: `apps/api/src/services/payroll-payout-*.ts`, `payroll-export.service.ts`, `routes/payroll-export.routes.ts`, `lib/payroll-export/`, `lib/payroll-gl-consumer.ts` atau berkas consumer GL payroll, schema/migrasi payout, test API terkait, kontrak `packages/shared` bila kode error baru.
- Jangan disentuh: UI (`apps/web`), modul uang lain (refund, POS, loyalty), cabang lain.
- Migrasi: rentang nomor sementara `0610-0613` (merge train menomori ulang). Jangan `NOT VALID` pada FK tabel FORCE RLS.

## Pembagian paralel (giliran pertama)
- Explore (3): satu per temuan, petakan jalur kode dan test yang ada.
- test-writer: satu test gagal-dulu per temuan sesuai "Usul test" di laporan, dijalankan terhadap base (`LEGEND_TEST_FILES=... heavy pnpm test`); catat nama test merah dan sebabnya.
- implementer (3): satu per temuan; berkas tumpang tindih (`payroll-payout-manual.service.ts` dipakai yjbjb dan w3691) dikerjakan berurutan atau dibagi per fungsi.
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- Test baru merah di base, hijau setelah fix; plus test payout/GL/export yang ada: `LEGEND_TEST_FILES="<daftar>" heavy pnpm test`.
- Pra-gate AGENTS.md: prettier, eslint, `pnpm db:generate` kosong bila migrasi, `heavy pnpm --filter @starter/api typecheck` (dan web bila shared berubah).
- Review: satu subagent `architect` effort xhigh (uang + migrasi) atas diff; temuan nyata dibetulkan sebelum lapor.
- Commit dan push cabang (tanpa force). Laporan: cabang, SHA, cabang induk, migrasi, test merah→hijau, angka subagent (total, puncak, pemegang heavy).
- Jangan merge ke m1 atau main, jangan deploy.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua error sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
