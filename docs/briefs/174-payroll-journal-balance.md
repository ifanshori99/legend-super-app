# Brief: engineer — jurnal payroll seimbang (legend-s8a3)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Repo: `/Users/ifanshori99/Projects/legend super app/legend`; jangan checkout di folder utama.

## Cabang
Cabang baru `ws/payroll-journal` dari ujung `ws/pph21-overwithhold` (7b486d73), worktree `.worktrees/payroll-journal`, `worktree:setup`. Jangan commit lagi di `ws/pph21-overwithhold` (masuk merge train setelah verifikasi CTO). Jangan push, jangan merge.

## Tujuan
`legend-s8a3` (naik ke P1, tingkat K): jurnal payroll selalu seimbang. Ganti placeholder `payroll_run.completed` dengan `payroll.locked` dan `payroll.reversed` (jurnal balik PAYR-05). Baris untuk pinjaman (piutang pinjaman), potongan lain termasuk telat, PPh21 ditanggung perusahaan, refund PPh21, service charge payable, reimbursement, serta piutang PPh21 baru dan tagihannya. Aturan `employee_loan.disbursed` dan `reimbursement.paid` bila belum ada. Detail: `bd show legend-s8a3`. Contoh nyata: dengan B (PPh21 ditanggung perusahaan) 124.062, jurnal selisih 124.062; harus jadi 0.

## Akun 1204 di setup lama
Setup akuntansi lama belum punya akun 1204 dan mapping `employee_receivable`, sehingga posting payroll ditolak `ACCOUNT_MAPPING_MISSING`. Thread lain (`ws/provisioning-race`, legend-hd1m/dq0n) sedang mengubah lock backfill CoA di service provisioning. Jangan ubah service provisioning. Tulis backfill 1204 sebagai migrasi data idempoten terpisah (catat nomor dan `when`) yang hanya menambah akun dan mapping yang hilang, dan sebut di laporan agar merge train menaruhnya setelah `ws/provisioning-race`.

## Kartu
`ghostex board associate legend-s8a3`, `bd update legend-s8a3 --priority 1 --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Scope
Boleh: `posting-rules.ts`, `accounting/fixtures.ts`, consumer jurnal payroll, kontrak event payroll bila perlu, migrasi data 1204, test. Jangan: service provisioning, auto-journal POS/refund, `pos-shift.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu (jurnal tidak seimbang untuk telat, pinjaman, PPh21 ditanggung, refund, piutang). Properti: semua jurnal payroll seimbang pada fuzz engine. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob, laporkan jumlah file jalan. tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/174b-second-opinion-payroll-journal.md` (tidak di-commit).

## Laporan
Sekali setelah selesai: hasil, contoh jurnal Rupiah sebelum/sesudah, bukti, file berubah, SHA, urutan merge, risiko. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja agar CTO memberi ke agent baru.

## Serah terima dari agent piutang PPh21 (brief 170)
- Selisih saat ini di `payroll_run.completed`: kredit − debit = B − refund karyawan − refund perusahaan − LATE − LOAN.
- Baris piutang `pph21ReceivableIdr` / `pph21ReceivableCollectedIdr` (akun 1204) sudah seimbang.
- Run totals di `payslips.ts` sudah membawa `pph21ReceivableIdr`, `pph21ReceivableCollectedIdr`, `loanRepaymentIdr`, `otherDeductionsIdr`, `serviceChargeIdr`, `reimbursementIdr`. Belum membawa terpisah: pajak ditanggung perusahaan, refund, tunjangan pajak.
- Harness fuzz diferensial architect untuk properti "semua jurnal seimbang": `docs/briefs/174-dfuzz.mts` (salinan, tidak di-commit).
- Kolom role mapping akun berupa `varchar` tanpa CHECK: migrasi data saja cukup untuk 1204.
- Lapor sekali saja di akhir; aturan "compact 2 kali" di atas tetap berlaku.
