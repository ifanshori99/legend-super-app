# Brief: engineer — tindak lanjut jurnal payroll (legend-75kr, legend-k8sz, legend-1coh)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/payroll-journal-followups` dari ujung `milestone/m1` terbaru, worktree `.worktrees/payroll-journal-followups`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tingkat K (uang, jurnal). Tiga temuan dari legend-s8a3 (jurnal payroll mendengar payroll.locked / payroll.reversed):
- `legend-75kr` (P2): `otherDeductionsIdr` (LATE + custom_deduction) mengkredit Beban Gaji. Potongan custom bisa titipan (iuran koperasi) yang harus ke liabilitas. Pisahkan totalnya dan beri role sendiri (default 6101). Reversal harus simetris.
- `legend-k8sz` (P3): role `service_charge` tidak bertipe; bila tenant memetakannya ke akun pendapatan, payroll.locked mendebit pendapatan. Tambah guard (tolak atau peringatan jelas) saat mapping disimpan, dan jalur posting yang aman bila mapping lama sudah salah.
- `legend-1coh` (P2): rule kasbon sementara mengkredit petty_cash (1102). Tambah `disbursedVia` (cash/bank) di payload event `employee_loan.disbursed` (`events.ts`), lalu varian rule #cash/#bank. Event lama tanpa field tetap memakai perilaku sekarang.
Detail: `bd show legend-75kr`, `bd show legend-k8sz`, `bd show legend-1coh`, `bd show legend-s8a3`.

## Kartu
`legend-75kr`, `legend-k8sz`, `legend-1coh`. Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: konsumen jurnal payroll dan rule auto-journal payroll/kasbon, mapping role akun (validasi), payload event payroll/kasbon di shared, layanan kasbon yang memancarkan event, test. Default role baru lewat seed/backfill tenant yang sudah ada polanya. Migrasi hanya bila wajib: nomor 0155 dengan when 1794234000000 (0153 dan 0154 sudah dipakai; catat). Jangan: refund, pos-day, pos-shift, edge, `receipt_sequences`, auth, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: potongan custom terposting ke liabilitas dan LATE tetap mengurangi beban, posting dan reversal seimbang; mapping service_charge ke pendapatan ditolak atau diberi peringatan sesuai keputusanmu (jelaskan); kasbon via bank mengkredit bank, via cash mengkredit kas, event lama tetap jalan. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/197b-second-opinion-payroll-journal-followups.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi/backfill dan langkah rilis, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
