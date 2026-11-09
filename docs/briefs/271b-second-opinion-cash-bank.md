# Brief: second-opinion — kas & bank, impor mutasi, pencocokan, setoran kas (legend-fnxl)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/cash-bank-recon`, cabang `ws/cash-bank-recon`.
Rentang diff: `git diff d2080951 HEAD` (isi cabang saja di atas `milestone/m1` d2080951; abaikan `apps/api/drizzle/meta/0191_snapshot.json`).
Keputusan desain: `docs/DECISIONS.md` "2026-11-10: WS-07 cash & bank reconciliation".

## Berkas berisiko

- `apps/api/drizzle/0191_cash_bank_recon.sql`, `apps/api/src/db/schema/accounting-cash-bank.ts` (+ `.custom.sql`): 7 tabel, FK inline, RLS tenant, RLS outlet pada `cash_deposits`, REVOKE pada log kasus.
- `apps/api/src/services/accounting-bank-matching.ts`: kandidat (jurnal + setoran kas), auto-match unik dua arah, `applyMatch`, kunci entitas.
- `apps/api/src/services/accounting-bank-csv.ts`: parser CSV ketat, dedupe per kemunculan.
- `apps/api/src/services/accounting-bank-statements.service.ts`: impor idempoten, ON CONFLICT, auto-match sesudah impor.
- `apps/api/src/services/accounting-bank-lines.service.ts`: match manual, exclude, unmatch, ringkasan.
- `apps/api/src/services/accounting-cash-deposits.service.ts`: setoran kas, alert ACC-05 dari `pos_shifts`.
- `apps/api/src/services/accounting-bank-recon-cases.service.ts`: kasus + log aksi, validasi jurnal write-off.
- `apps/api/src/services/accounting-bank-accounts.service.ts`: nomor rekening tersegel + HMAC.

## Invariant (PRD)

- ACC-04: auto-match ≥ 99% hanya pada kecocokan pasti; tidak menebak; satu dokumen hanya ke satu mutasi; setiap selisih jadi kasus dengan PIC, tiap aksi tercatat.
- ACC-05: alert kas belum disetor muncul tepat sesudah `maxDaysUndeposited` hari (kebijakan tenant).
- Impor ulang berkas yang sama tidak menggandakan baris.
- Isolasi tenant dan outlet (TEN-01..03); nomor rekening tidak pernah keluar dalam bentuk jelas (respons, audit, log).
- Tidak ada posting jurnal otomatis di cabang ini.

## Yang diminta

1. Balapan: dua impor bersamaan untuk rekening yang sama / dua rekening yang berbagi akun GL; match manual vs unmatch vs buka kasus vs setoran baru (auto-match). Cari jalur tulis tanpa `entityLock`.
2. Uang: jumlah bertanda (debit/kredit), parser jumlah, pembulatan, overflow bigint → Number; jumlah jurnal neto pada akun GL; zona waktu tanggal setoran (outlet) vs `posted_on`.
3. Auto-match: ada kasus yang mencocokkan padahal ambigu (dua kandidat, dua mutasi berebut satu dokumen, jurnal yang dibalik, jurnal di balik setoran)?
4. Unmatch: keadaan baris, match, dan setoran benar-benar kembali seperti sebelum match?
5. Migrasi: aman di DB yang sudah migrasi sampai 0186 (FK ke tabel FORCE RLS, urutan `when`), RLS outlet `cash_deposits`, REVOKE log kasus.
6. Formula koleksi kas ACC-05 dari `pos_shifts` (drop, cash in, refund, shift belum ditutup).

## Effort

xhigh (uang + migrasi).

## Laporan

Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan

Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
