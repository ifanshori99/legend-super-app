# Brief: engineer — persetujuan dana tak teralokasi dan kasus rekonsiliasi lewat approval_requests

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Cabang akhir: `ws/payment-approvals`.

## Tujuan
Refund sudah lewat `approval_requests` (lihat `payment-refund.service.ts` `handleRefundApprovalResolved`, test `payment-refund-approval.test.ts`). Yang kurang: penyelesaian dana tak teralokasi (PAY-04) dan penutupan kasus rekonsiliasi harus membuat/menunggu approval_request, dicek ulang di server, baru dieksekusi. Tampilkan `approvalRequestId`/`approvedBy` di view admin refund bila belum. Kedua: audit `legend-m0k` mode standalone EDC (PIN supervisor wajib di server); bila celah, tutup.

## Kartu
`legend-hcqs` (utama), `legend-m0k` (audit sisa). Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`. m0k sudah lengkap: tulis bukti di komentar, status review.

## Aturan uang (wajib)
Tingkat K (uang + akses). Jangan sampai rugi: test bukti bahwa dana tak teralokasi tidak bisa dialokasikan/dicairkan dua kali, tidak bisa dieksekusi tanpa approval yang disetujui, approval yang ditolak/kedaluwarsa tidak mengeksekusi, pengaju tidak bisa menyetujui sendiri (ikuti pola refund), dan approval milik tenant lain ditolak. Bila ragu, pilih aturan yang paling membatasi dan tulis di laporan.

## Scope
- Boleh: `apps/api/src/services/payment-*.ts`, approval handler terkait, routes payment admin, `packages/shared` validator/DTO payment, `apps/web/src/features/payment*` (hanya menampilkan field approval), test di `apps/api/src/test/`.
- Jangan disentuh: jurnal GL otomatis (thread lain, brief 675), loyalty/referral, payroll.
- Migrasi (bila perlu, mis. action_type baru): rentang `0565-0567` saja.

## Pembagian paralel (giliran pertama)
- Explore (3): alur refund approval yang sudah ada; alur unallocated funds + rekonsiliasi; EDC standalone/PIN (m0k).
- test-writer: test gagal-dulu vitest untuk unallocated + rekonsiliasi + m0k (bila celah), dijalankan terhadap base dengan `LEGEND_TEST_FILES=... heavy pnpm test`.
- implementer: satu untuk unallocated, satu untuk rekonsiliasi, satu web view (bila perlu).
- Pemegang token heavy: satu `test-runner`.
- Review: satu subagent `architect` effort xhigh (uang + akses) sebelum lapor; temuan nyata dibetulkan.

## Bukti selesai
- Test terarah file yang diubah hijau (`LEGEND_TEST_FILES=... heavy pnpm test`).
- Pra-gate AGENTS.md: prettier, eslint, typecheck api (+web bila tersentuh) lewat `heavy`.
- `node ~/.agents/team/check-journal.mjs origin/milestone/m1` bila ada migrasi.

## Batas kerja ulang dan sebelum melapor
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang", "Sebelum melapor", dan "Laporan" (rename cabang `ghostex/*` ke `ws/payment-approvals`, push tanpa force, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`). Jangan merge ke milestone/m1, jangan deploy.
