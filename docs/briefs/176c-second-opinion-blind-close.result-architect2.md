# 176c result, architect 2 (Claude double review, brief 225)

Kartu: legend-4wrfd. Diff 6b3c6840..545bf785, merge 4e73fb4b, ada di milestone/m1 (94d769c6). Sesudah merge, berkas berisiko hanya disentuh fa472534 (pos-day, schemas: day recap) dan 287ed9f4 (refund); jalur shift tidak berubah.

## Hasil: Bersih (tidak ada P1/P2)

Invariant per butir (kode di milestone/m1):
- B1 tahan. open dan replay open buta (pos-shift.service.ts:212, :299); close dan replay close buta (:1235, :1333); report dan movements memakai assertCanRead (:312-329): pemegang view_all/approve_close pada shift sendiri dapat seesLiveFigures=false; list (:407) buta untuk shift sendiri dan untuk pemanggil tanpa view_all; listPosShiftCounts menolak shift sendiri (:889); count receipt hanya countedIdr + noteRequired (pos-shift-support.ts:851-868); override cash_shift_close menyembunyikan valueIdr dari peminta (staff-override.service.ts:104-120) dan approval inbox membuang amount/payload.valueIdr untuk peminta (platform-approval.service.ts:160-175). Pesan RangeError di jalur shift tidak memuat angka laci (calculations.ts:184).
- B2 tahan untuk respons shift: semua respons kasir buta, noteRequired dihitung dengan koreksi held (legend-y9bf/utqr).
- B3 tahan: shiftFiguresDto untuk shift tertutup membaca angka tersimpan; event cashier_shift.closed, audit (shiftAuditView) dan writeClose memakai bentuk penuh (:1443, pos-shift-support.ts:898).
- B4 tahan: forceClosePosShift butuh approve_close (:1533), menolak shift sendiri (:1537), hitungan harus forced milik pemanggil (:1571), saksi pihak ketiga (:1553-1557). Respons penuh hanya untuk supervisor itu.
- B5 tahan: fingerprint replay memuat userId (:1199-1205, :1518-1524); replay close kasir buta, replay force close penuh untuk supervisor yang sama.
- B6 tahan: superRefine schemas.ts menolak campuran null/terisi pada lima angka rincian, shift tutup tidak buta wajib expected+variance, rumus expected tetap dicek bila lengkap.
- B7 tahan: web memetakan PosShift tanpa membaca angka laci (apps/web/src/features/ws04-pos-kasir/api.ts activeShiftFrom).
- Test tidak dilemahkan: az-e-cashier-shift dan cash-shift-close-default-tier kini menegaskan null di respons kasir lalu membaca angka lewat laporan supervisor atau baris DB; pos-cash-guard withStoredFigures menegaskan tujuh kolom null sebelum menambah angka tersimpan.

## Temuan P3 (tanpa kartu)
- apps/api/src/services/pos-shift.service.ts:573-585 (sudah ada sebelum diff, legend-1hza): batas kas masuk menolak bila opening + cashSales + cashIn + amount > MAX_SAFE_INTEGER. Kasir dapat menebak cashSales secara serakah dengan probe cash_in menurun (2^52, 2^51, ...): yang diterima tercatat, sisa ruang akhirnya < 1, sehingga cashSales = MAX - opening - total cash_in. Bising (baris kas masuk raksasa tercatat dan diaudit, variance tutup jadi besar), jadi P3. Saran: samakan dengan pola outflow (assertShiftOutflowBound tanpa angka laci), mis. batas per gerakan jauh di bawah MAX dan batas total yang tidak bergantung pada cashSales.
