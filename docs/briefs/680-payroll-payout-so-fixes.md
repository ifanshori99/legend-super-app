# Brief: engineer — perbaikan temuan second opinion payout gaji

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/finance-exceptions` (598cd9cb1; memuat payroll-payout-hardening). Cabang akhir: `ws/payroll-payout-so-fixes`. Cabang ini menggantikan ws/finance-exceptions di batch62.

## Tujuan
Tutup 3 temuan Codex (brief 670). Keputusan CTO sudah diambil, jangan dibuka ulang:
1. `apps/api/src/services/payroll-payout-overpaid.service.ts:220`: rekening sumber dibekukan per batch saat approve/export (simpan id rekening di batch). Ganti sumber setelah batch gagal tidak boleh mengubah rekening yang dipakai batch lama; jurnal overpaid untuk transfer lama selalu mengkredit rekening beku batch itu.
2. `apps/api/src/services/payroll-payout-gl.service.ts:202`: validasi rekening sumber aktif sebelum percabangan jurnal. Akuntansi aktif tanpa jurnal locked dan sumber nonaktif harus 409 `PAYOUT_SOURCE_ACCOUNT_MISSING`, bukan `settle_skipped`.
3. `apps/api/src/services/payroll-payout-setup.ts:54`: mapping biaya siap hanya bila akun (mis. 8101) aktif dan bisa diposting; approve/export ditolak bila tidak. Akun dinonaktifkan setelah export: konfirmasi pembayaran tetap tercatat (uang sudah keluar), biaya dicatat sebagai tertunda lewat pola marker yang sudah ada (8codi) supaya muncul di pengecualian finance; jangan rollback konfirmasi.

## Kartu
Buat kartu bd untuk tiap temuan (`bd create`, discovered-from legend-s7roi), lalu ikuti aturan kartu di `~/.agents/team/brief-template.md`.

## Aturan uang
Tingkat K. Test bukti: tidak ada karyawan dibayar dua kali, jurnal tidak mengkredit rekening yang salah, konfirmasi tidak hilang. Ragu: aturan paling membatasi, tulis di laporan.

## Scope
- Boleh: service payroll payout (`payroll-payout-*.ts`), schema batch payout bila perlu kolom, test terkait.
- Jangan: jurnal otomatis umum (brief 675), loyalty, payment refund, persetujuan dana tak teralokasi (brief 679).
- Migrasi: rentang `0568-0570` saja. Wajib `node ~/.agents/team/check-journal.mjs origin/milestone/m1` (base ini punya riwayat idx ganda 333/334; betulkan bila muncul).

## Pembagian paralel (giliran pertama)
- Explore (2): alur sumber rekening approve/export/overpaid; alur setup mapping + marker 8codi.
- test-writer: test gagal-dulu untuk 3 temuan, dijalankan di base.
- implementer: 1 per temuan (temuan 1 dan 2 bila filenya bertumpuk: berurutan).
- Heavy: satu `test-runner`. Review: satu `architect` effort xhigh.

## Bukti selesai
Test terarah payroll payout hijau lewat `heavy`, pra-gate AGENTS.md, check-journal hijau.

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (rename cabang, push tanpa force, baris Subagent). Jangan merge ke milestone/m1, jangan deploy.
