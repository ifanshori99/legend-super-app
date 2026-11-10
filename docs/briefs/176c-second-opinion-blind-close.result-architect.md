# 176c hasil architect 1 (review ganda Claude, brief 225)

Kartu: legend-4wrfd. Kode diperiksa: `milestone/m1` 94d769c6 (merge 4e73fb4b = ws/shift-blind-close 545bf785). Perubahan sesudahnya di berkas yang sama (fa472534 legend-awg5p, 287ed9f4 refund promo) tidak membuka jalur baru.

Hasil: **Bersih** (tidak ada temuan P1/P2).

## Per invariant
- B1 bersih. `closePosShift` hanya untuk kasir pemilik (`pos-shift.service.ts:1221`), jawaban dan replay buta (`:1235`, `:1333`). `openPosShift` dan replay buta (`:212`, `:299`). Laporan dan daftar buta untuk shift sendiri atau tanpa view_all/approve_close (`assertCanRead` `:318-327`, `listPosShifts` `:407`). `listPosShiftCounts` ditolak untuk shift sendiri (`:889`). Tanda terima hitung hanya `countedIdr` + `noteRequired` (`pos-shift-support.ts:851`). Pesan error close (RangeError `calculations.ts:184`, PosError) tidak membawa angka. Override `cash_shift_close`: nilai disembunyikan dari peminta (`staff-override.service.ts:105`, `platform-approval.service.ts:160-175`); cek tier close tanpa nominal (`pos-shift.service.ts:1060`), jadi tidak ada oracle tier.
- B2 bersih. DTO buta tidak punya field yang bergantung pada status held; movement tanpa `needsApproval` untuk kasir (`pos-shift-support.ts:889`).
- B3 bersih. Supervisor membaca shift orang lain: closed dari baris, open dari agregat live; event/audit/ledger memakai `shiftFiguresDto`.
- B4 bersih. Force close butuh `approve_close`, menolak shift sendiri (`:1536`), saksi orang ketiga; jawaban penuh hanya ke supervisor itu.
- B5 bersih. Fingerprint memuat `op` dan `userId`, jadi kunci milik orang lain atau operasi lain ditolak `IDEMPOTENCY_KEY_REUSED`.
- B6 bersih. `posShiftSchema` (`schemas.ts:929`): buta = 7 field null bersama; penuh = 5 rincian ada, expected/variance wajib ada saat closed dan dicek terhadap rumus. Open penuh membawa expected/variance null, sesuai aturan shift open.
- B7 bersih. `apps/web/src` tidak membaca ketujuh field itu.
- Test: dua acceptance tidak melemah; variance kini dibaca dari baris DB atau laporan supervisor dengan nilai sama.

## P3
- Daftar movement memperlihatkan nominal tiap cash in/out/drop ke kasir (catatannya sendiri), jadi `cashIn/Out/DropIdr` bisa dijumlah ulang. Sesuai desain (kasir yang mencatat), bukan kebocoran expected/variance.
