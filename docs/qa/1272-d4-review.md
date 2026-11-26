# Review K D4 ekspor dan jadwal laporan (ws/1272-d4 64d527763)

Reviewer: architect (Opus, high), 27 Nov. Baca kode saja. Hasil: **GAGAL** (1 P1 migrasi), 1 P2, 6 P3.

## Aman
- Hanya pemilik (404 selain itu); akses tiap penerima dicek ulang saat simpan dan tiap run (user diblokir dilewati); cakupan outlet + `full`/`aggregate` dicek saat unduh.
- Unique `(schedule, slot, recipient)` + SKIP LOCKED; prefix formula CSV/XLSX aman; worker hanya mode cloud.

## Temuan
1. P1 `0539_report_delivery.sql`, `_journal.json:3673-3679`: tabrakan dengan `0539_edc_settlement_csv` di int/rc2, basis snapshot salah. Rebase ke int/rc2, generate ulang jadi `0540_report_delivery`, `db:generate` kosong.
2. P2 `report-exports.service.ts:660-675`, sweep `871-883`: job macet `generating` bila worker mati. Timeout -> kembali `queued` (maks percobaan, lalu `failed`), dengan test.
3. P3 `:602-608` `generate` tolak kecuali `gate.action === "queue"`.
4. P3 RLS ganda di migrasi (hilang saat generate ulang).
5. P3 `:362` `ownRow` pilih kolom metadata saja (tanpa bytes berkas).
6. P3 `report-schedules.service.ts:257-266` tolak jadwal pada saved report terarsip.
7. P3 `:564-573` run cek ulang pemilik; pemilik keluar tenant/diblokir = jadwal dijeda + notifikasi admin tenant.
8. P3 `:575-597` slot maju sebelum job dibuat: terima at-most-once, dokumentasikan di komentar + docs.

## Keputusan CTO 27 Nov
Semua dibetulkan sekarang (P1, P2, P3 3-8). Re-review cukup diff perbaikan.
