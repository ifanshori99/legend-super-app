# 1272 legend-f1mmf: serah terima (27 Nov)

Cabang `ws/1272-f1mmf`. Bead: legend-f1mmf (backend tukar menu QRIS/EDC, lalu buka layar Tagih selisih).

## Sudah

1. `GET /api/order-issue-charges/:chargeId` (kontrak `@starter/shared/pos` `getPosIssueCharge`, `posIssueChargeDetailSchema`). Service `apps/api/src/services/order-recovery-charge-pos-read.ts`. Nominal, baris tukar, kode yang masih bisa menerima uang, dan penjualan EDC tagihan itu semuanya dari server. Test `order-issue-charge-pos-read-f1mmf.test.ts` (7, gagal dulu).
2. `POST /api/order-issue-charges/:chargeId/edc` (kontrak `startPosIssueChargeEdc`). Service `order-recovery-charge-pos-edc.ts`. Test `order-issue-charge-pos-edc-f1mmf.test.ts` (5, gagal dulu).
3. Guard uang baru: `assertNoEdcSaleOutstanding` (nontunai.ts) dipasang di QRIS dan tunai. `edcSaleChargePayable` (pos-order-support.ts) dipasang di write-ahead agent EDC.
4. Test lama yang diubah: `order-charge-refund-982-pos-nontunai-gt98h.test.ts`, dua kasus yang membuat QRIS padahal penjualan EDC sudah disetujui (aturan baru menolaknya). 53 test terkait lulus.

## Keputusan uang yang diambil (paling ketat)

- Kode "hidup" memakai `liveCodeWhere`, aturan yang sama dengan penolakan `createIntent` (ORDER_CODE_ACTIVE). Selama kode hidup, GET menampilkan `pending`, jadi kunci di kasir dan aturan server tidak pernah berbeda. Kode yang sudah lewat waktunya ditanyakan dulu ke provider lewat jalur poll (`settleGatewayIntentNowDetailed`). Bila uangnya sudah ada, dicatat sekali. Bila jawabannya final dan lewat margin, kode ditutup. Bila jawaban tidak jelas, kode tetap hidup.
- Satu jalur uang pada satu waktu. Penjualan EDC tagihan (reference = id tagihan) yang masih pending, unknown, sudah disetujui, atau sedang direkonsiliasi menolak QRIS, tunai, dan penjualan EDC baru. Sebaliknya, kode QRIS yang hidup atau intent yang sudah dibayar menolak penjualan EDC. Kedua sisi mengambil advisory lock agent (tenant, outlet:reference), jadi tidak bisa lolos bersamaan.
- Nominal EDC selalu `amount_idr` tagihan. Agent menolak nominal lain (EDC_AMOUNT_MISMATCH), tagihan yang sudah tertutup atau dibayar, dan order yang di-void.
- Tenant lain, outlet lain, kasir aktif outlet lain, atau tanpa `pos.payment.accept` di outlet tagihan: 404 (GET dan EDC).

## Sisa

- (d) Pembatalan percobaan di server (supervisor, beraudit): butuh keputusan, lihat pertanyaan di bawah.
- Web: sambungkan GET (hapus CONTRACT_PENDING di `charge-api.ts`), tombol mulai EDC + pilih terminal, blocker a/b/c/e dari re-review architect 25 Nov, test node/komponen, screenshot 390/1280.
- Typecheck api+web, text-contract, review K (architect), second-opinion area.

## Pertanyaan ke CTO (usulan paling ketat)

1. Batal QRIS tagihan: gateway tidak punya cancel. Usulan: tidak ada batal sebelum kode lewat waktu + 60 detik dan provider menjawab final. Kasir menunggu, server menutup kode basi sendiri. Tidak ada endpoint batal.
2. Percobaan tunai atau EDC tanpa jawaban di browser lain: usulan memakai pola supervisor PIN 1268 W2 (`payment-intents/resolve`) untuk tagihan, dengan kunci `cash:`/`edc:` per tagihan. Ini desain baru, butuh architect. Sampai itu ada, layar tetap dikunci pada metode yang belum pasti.
3. Layar dibuka sebelum (d) selesai? Usulan: tidak. CONTRACT_PENDING tetap sampai (d) dan review K lulus.

## Keputusan CTO 27 Nov

1. Batal QRIS: usulan diterima. Tidak ada endpoint batal; kode basi ditutup server sesudah lewat waktu + 60 detik dan jawaban final provider.
2. Tunai/EDC tanpa jawaban: pakai pola supervisor PIN 1268 W2 (`payment-intents/resolve`) untuk tagihan, kunci `cash:`/`edc:` per tagihan, alasan wajib, penyetuju bukan pemanggil, audit. EDC `unknown` hanya boleh diselesaikan dengan bukti slip (RRN + kode approval) atau dinyatakan gagal sesudah cek terminal; tidak pernah dianggap lunas tanpa bukti. Desain dicek architect di review K.
3. Layar tetap terkunci (CONTRACT_PENDING) sampai (d) dibangun dan review K lulus.

## Review K 27 Nov: pengerjaan (sesi lanjutan)

Sudah (commit 6cabc2655, typecheck api lulus, 72+551 test terkait lulus):
- Temuan 1: QRIS/VA tamu menolak selama penjualan EDC tagihan belum selesai/disetujui.
- Temuan 3: tunai menolak selama kode tagihan masih hidup (`liveCodeWhere`); kode basi ditanyakan dulu ke provider (`closeLapsedChargeCodes`). Guard pindah ke `order-recovery-charge-money-path.ts`. Empat test lama "tunai menang" disesuaikan ke aturan baru.
- Temuan 2: test write-ahead agent dengan id tagihan (nominal, dibayar/tutup, void, kode hidup), 404 tanpa izin bayar di outlet tagihan (tanpa izin sama sekali: 403 dari route).

Sedang (d), WIP:
- Kontrak `resolvePosIssueChargeAttempt` di `packages/shared/src/pos/issue-charge.ts` (method cash/edc + idempotencyKey, pernyataan edc failed/paid, slip, alasan, penyetuju, PIN).
- `order-recovery-charge-attempt-key.ts`: penanda tutup di `pos_order_idempotency` (key `oic-attempt:<sha256>`).

Sisa (d):
- Service `order-recovery-charge-pos-resolve.ts`: penyetuju != pemanggil (403), izin override `void` (cash) / `edc_standalone` (edc) + `payment.reconcile` untuk `paid`, `attemptApproverPin`, lalu di bawah kunci tagihan + advisory lock agent: cash (movement dengan kunci itu = recorded, selain itu tutup); edc (tanpa sale = tutup; pending/wire terbuka = 409; approved = catat sekali; unknown tanpa pernyataan/slip = 409, `paid` lewat `resolveEdcReconciliation` approved lalu catat sekali, `failed` lewat declined lalu closed; flagged = 409).
- Pasang cek penanda di jalur tunai (sesudah replay), start EDC (sesudah `earlier`), dan `edcSaleChargePayable` (tambah `idempotencyKey` opsional dari agent).
- Ekstrak pencatatan EDC dari `collectChargeAtPosEdc` jadi fungsi bersama.
- Route `POST /order-issue-charges/:chargeId/attempts/resolve` (middleware sama `/edc`), audit `order_issue.charge_attempt_resolved`.
- Test wajib (d) sesuai daftar CTO di review, typecheck api+web, prettier/eslint.

### Update (d), WIP commit berikut (kuota habis, berhenti di sini)

Sudah ditulis, BELUM dijalankan (test, typecheck):
- `apps/api/src/services/order-recovery-charge-pos-resolve.ts` (service lengkap sesuai desain di atas).
- Route `POST /order-issue-charges/:chargeId/attempts/resolve` di `order-recovery-charge.routes.ts`.
- Cek penanda tutup dipasang di tunai, start EDC, `edcSaleChargePayable` (agent meneruskan `idempotencyKey`).
- `recordEdcSaleOnCharge` diekstrak dari `collectChargeAtPosEdc` (nontunai.ts); field audit baru di `AUDIT_SAFE_FIELDS`.
- Test `apps/api/src/test/order-issue-charge-pos-resolve-f1mmf.test.ts` (7 kasus: 403/PIN/404, tunai recorded/closed, EDC tanpa sale closed + start telat ditolak tanpa terminal, unknown 409 x5, slip beda 409, slip valid sekali + butuh payment.reconcile, gagal -> QRIS -> persetujuan telat terkunci, total <= amount). Lint bersih.

Sisa:
- Jalankan: `LEGEND_TEST_FILES="src/test/order-issue-charge-pos-resolve-f1mmf.test.ts src/test/order-issue-charge-pos-edc-f1mmf.test.ts src/test/order-issue-charge-collect-pos.test.ts src/test/order-charge-refund-982-pos-nontunai-gt98h.test.ts" heavy pnpm test`, perbaiki yang gagal (belum ada bukti gagal-dulu terpisah untuk (d): service dan test ditulis bersamaan; bukti gagal-dulu = jalankan test pada commit 32c4c02ef bila perlu).
- Jalankan ulang 21 file test terkait tagihan (daftar di commit 6cabc2655) karena jalur EDC dan agent berubah.
- Typecheck api + web lewat `heavy` (shared berubah), prettier check.
- Review K ulang (architect) untuk (d), lalu web.

### (d) dijalankan dan lulus (27 Nov, sesi lanjutan)

- Bukti gagal-dulu: implementasi commit 1af2f4a23 dibalik sementara (kontrak 32c4c02ef tetap), test resolve 7/7 gagal (route 404). Sesudah dipulihkan 7/7 lulus.
- Perbaikan test saja: fixture `trace` memakai UUID dengan tanda hubung (ditolak `ecrTraceSchema`); kini huruf dan angka saja.
- 21 file test tagihan/EDC terkait: 404/404 lulus.
- Typecheck api awalnya gagal (id dan nominal tanpa brand di attempt-key dan dua test f1mmf), dibetulkan; kini api dan web lulus lewat `heavy`. Ulang 4 file (resolve, edc, collect-pos, pos-edc-tender): 146/146 lulus.
- Prettier, eslint file tersentuh bersih.
- Berikut: review K ulang (architect) untuk (d), lalu web.

### Review K (d) LULUS dengan 1 P2: dibetulkan (27 Nov)

- P2: penjualan EDC disetujui dengan nominal lain dari tagihan kini 409, tagihan tetap open (`record()` cek `sale.amountIdr`). Gagal dulu: tanpa fix tercatat lunas.
- P3: slip nominal beda memberi alert `edc_transaction.reconciliation_mismatch` sesudah rollback (pola X1). Gagal dulu: tanpa alert.
- P3: `if (!charge) return false;` ganda di `pos-order-support.ts` dihapus.
- P3 test: disetujui tanpa tanda = recorded sekali, ulang tetap sekali; 404 outlet lain untuk `method: "edc"`.
- 6 file test (resolve, edc, collect-pos, pos-edc-tender, edc-agent-amount, edc-reconciliation) 213/213 lulus; typecheck api lulus; prettier/eslint bersih.
- Berikut: satu reviewer sonnet atas diff fix, lalu web.

### P3 + web (27 Nov, ui-engineer), commit e5382a136

Sudah:
- P3: `edcReconciliationMismatchOf` (edc-reconciliation.service.ts) dipakai catch resolve; slip nominal tagihan pada sale unknown nominal lain = 409 + alert outbox. Gagal dulu (alert 0), sesudah fix 3 file (resolve, edc, edc-reconciliation) 80/80 lulus.
- Web: CONTRACT_PENDING dihapus; GET, start EDC, resolve memakai `@starter/shared/pos`. Tombol EDC + pilih mesin (payment options, kartu saja), status menunggu, "Cek di mesin".
- (a) pemilih terkunci sejak awal (`lockedAttempt`, hanya metode belum pasti + alasan); (b) 401/403/429 pada kiriman pertama menghapus kunci (`collectKeyAfter(status, firstSend)`, 503 EDC_AGENT_NOT_READY juga); (c) QRIS: id kode server berganti + berakhir membebaskan semua metode; (e) GET pra-kirim `readWithin` (AbortController, 8 dtk), gagal = tidak kirim, kunci tetap, pesan.
- (d) `charge-resolve-dialog.tsx`: penyetuju, PIN, alasan; EDC unknown: kartu tidak terdebet / terdebet + slip (RRN, approval, nominal di slip). Teks dari kode server (ISSUE_CHARGE_*). Kunci start EDC disimpan per sale.
- Rincian memakai `amountIdr` server (tidak lagi menjumlah di UI).
- Test node 6 baru (gagal dulu pada b64ba29c3), 132/132 lulus; text-contract lulus; typecheck web + api lulus; prettier/eslint bersih.

Sisa:
- Screenshot 390/1280 (siap bayar, menunggu EDC, unknown, resolve supervisor, lunas) ke `docs/review/img/f1mmf-*.png`.
- Review K (architect) untuk web + P3, second-opinion area.
