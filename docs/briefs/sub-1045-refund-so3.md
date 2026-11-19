# Brief subagent 1045: perbaikan SO refund ronde 3

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-3312339e` (base c118f02a5 = 1025 + 1033 + 1035). Tingkat K (uang).
Sumber: `docs/qa/second-opinion-refund-ronde3-1044.md` (temuan 1-4, baris mengacu c118f02a5). Ronde 2: `docs/briefs/sub-1035-refund-so2.md` (desain kind, hold live_own).
Aturan CTO: tanpa kepastian status provider -> tahan (hold) dan tolak refund baru; jangan retry terbuka tanpa hold. Data lama ambigu -> jenis yang paling menahan uang. Founder: tamu tidak dibayar lebih, outlet tidak rugi, jurnal = uang nyata. Belum ada production; deploy = stop, migrate, start.

## Temuan

- **F1 / legend-w2td5.** Poller (`payment.service.ts` ~3839-3856) tidak memilih intent paid; `payment-refund.service.ts` ~643-678 (failRefund) melepas reservasi saat refund kita gagal tanpa tahu status transaksi provider. Provider me-refund A terpisah, webhook hilang, R gagal -> refund baru dikirim -> bayar dua kali.
- **F2 / legend-d7im9.** `payment-provider-partial-refund.ts` ~320-342 (waitForInFlight, refund kita sudah dicoba tanpa ref) dan ~425-429, ~458 (mustWait) mengembalikan `retry` tanpa hold/fact; `payment-webhook.service.ts` ~993-995 menyisakan event untuk retry; guard `payment-provider-refunded-guard.ts` ~114-132 tidak memblokir dari event itu; stamp intent bisa tidak ditulis (`payment.service.ts` ~3467-3471, ~3540-3549). R gagal sebelum worker replay -> refund baru lolos.
- **F3.** Backfill 0656 (`apps/api/drizzle/0656_provider_refund_id_kind.sql`) menebak `synthetic_full` dari bentuk ID (`payment:<ref>`, hash, prefix) padahal ID provider asli boleh berbentuk itu.
- **F4.** Unique key 4 kolom vs ON CONFLICT 3 kolom penulis lama saat deploy: diterima CTO, cukup dicatat di `docs/deployment.md`.

## Desain diputuskan

### F3 (implementer: 0656 saja; 0656 belum landing, boleh diubah)
- Backfill TIDAK menebak: semua baris lama `payment_provider_refunds` tetap `refund_id_kind='provider'` dengan `provider_refund_id` apa adanya; semua hold lama dengan `provider_refund_id` terisi -> `provider_refund_id_kind='provider'`, id apa adanya. Hapus semua UPDATE yang menebak synthetic_full/synthetic_hold. Alasan uang: fact provider dikurangkan dari sisa saat laporan synthetic_full datang (recorder `left`), jadi tidak ada hitung ganda; hold provider di-resolve dengan nominalnya sendiri (bukan sisa transaksi); tidak ada benturan unique (ID lama tetap unik seperti di kunci 3 kolom).
- Test (test-writer, berkas baru `apps/api/src/test/refund-1045-c-legacy-backfill.test.ts`): baris berbentuk lama ditulis langsung (kind default) lalu diuji lewat service/route: hold mismatch `payment:foo` 30k atas transaksi foo 100k -> resolve `counted_against_intent` mencatat 30k (bukan sisa 100k), `not_this_intent` diterima; replay laporan refund ID `payment:foo` (event id baru) -> tidak ada hold kedua/fact kedua; laporan status `refunded` transaksi foo sesudahnya -> fact hanya sisa (70k), total fact = 100k; hold lama tanpa payment ref bisa di-resolve; dua ID lama `payment:foo` dan `payment:h:<sha256(foo)>` hidup berdampingan tanpa benturan; tenant lain tidak terpengaruh. Plus satu test yang membaca berkas SQL 0656 dan memastikan tidak ada UPDATE ke `synthetic_full`/`synthetic_hold` (penjaga regresi).

### F4 (doc)
- `docs/deployment.md`: bagian migrasi: rilis yang memuat 0656 (dan migrasi refund lain) wajib stop API + worker, migrate, start (bukan rolling); alasan (ON CONFLICT 4 kolom, CHECK kind); rollback = restore backup sebelum migrasi; setelah start, worker mengulang event webhook yang tertunda.

### F1 (implementer Opus; file: payment-refund.service.ts failRefund, payment.service.ts poller, payment-live-code.ts bila perlu, helper hold baru boleh di refund-recon-hold.service.ts)
- Hold baru `reason = 'own_refund_failed_unverified'` (konstanta bersama). Dipasang di `failRefund` (payment-refund.service.ts ~644-738) dalam tx yang sama, bila refund itu SUDAH terkirim ke provider: `provider_ref` terisi ATAU `payout_attempts > 0` ATAU `payout_pending_polls > 0` (apa pun alasan gagalnya). Kolom: amount_idr = nominal refund, provider_refund_id NULL (kind NULL), provider_payment_ref = ref transaksi yang direfund (transaksi utama intent, atau ref transaksi tambahan untuk refund fund), webhook_event_id = hash deterministik ('own_failed', tenant, refund id) + ON CONFLICT DO NOTHING (sekali per refund). Urutan lock sama dengan fileLiveOwnHold (intent row -> deposit-intent exclusive) dan cek urutan terhadap pemegang lock failRefund (intent -> fund -> refund); jangan membuat siklus. Tanpa alert saat dibuat (diverifikasi poller).
- Refile otomatis (`refileQrLatePaymentAfterFailure`, `refileBreakfast...`, `refileRecovery...`, `settleSystemRefundFailure`) tidak boleh membuat failRefund gagal: refund pengganti boleh dibuat (pending) tetapi pengiriman/approve tetap diblokir guard sampai hold ditutup. Periksa dan sebut perilakunya.
- Verifikasi poller: `pollPendingGatewayIntents` (payment.service.ts ~3810) juga memilih intent yang punya hold `own_refund_failed_unverified` terbuka dengan provider_payment_ref = transaksi utama intent (refund fund/transaksi tambahan TIDAK diverifikasi otomatis: tetap untuk finance). `getStatus` di luar tx. Lalu di tx dengan lock intent:
  - Jawaban pasti belum di-refund (status paid DAN rawStatus status lunas biasa provider, bukan refunded/partial/unknown; cek peta wire DOIT `payment-doit-wire.ts` ~335 dan Duitku) -> tutup hold: resolved_at, resolution 'not_this_intent', catatan otomatis, tanpa efek lain.
  - Jawaban refunded -> jalankan jalur markProviderRefunded biasa (mencatat fact sisa), hold TETAP terbuka untuk finance (anomali: refund kita gagal tapi provider bilang refunded).
  - Galat/tidak tersedia/status lain -> hold tetap; dicoba lagi siklus berikut.
- Guard yang ada (`openReconHoldSql`) sudah memblokir refund baru (409 PROVIDER_REFUNDED), approve, klaim kirim, dan fund. Jangan ubah guard.

### F2 (implementer Opus; file: payment-provider-partial-refund.ts saja)
- Tiap `return { status: "retry" }` yang terjadi karena refund kita masih berjalan (~342 waitForInFlight non-synthetic, ~429, ~442, ~458 mustWait; BUKAN ~298 balapan settlement) memanggil `fileLiveOwnHold(nominal refund live, outlet)` lebih dulu di tx yang sama, lalu tetap return retry (event diulang worker/poller). Dedup tetap per laporan (refundKey), satu hold walau diulang.
- Replay yang mencatat fact (status `recorded` untuk laporan yang sama, refund kita sudah gagal) menutup hold live_own dengan dedup key yang sama di tx yang sama: resolved_at, resolution 'counted_against_intent', catatan otomatis. Hasil `own`/`duplicate` tidak menutup hold (tetap untuk finance). Hold milik laporan lain tidak disentuh.
- Pastikan stamp/guard: setelah perubahan, refund baru ditolak di setiap jeda (event diterima -> retry -> R gagal -> sebelum replay).

## Test (test-writer)

- Berkas baru per temuan: F1 `apps/api/src/test/refund-1045-a-no-webhook-failed-own.test.ts`, F2 `apps/api/src/test/refund-1045-b-retry-holds.test.ts`, F3 di atas.
- Pola fixture: `refund-1035-a-pending-ref-own.test.ts` (gateway palsu DOIT, deliver, pollSoon, runWorker, failOwn, manualRefund/approveRefund, probe payout), `refund-1035-b-synthetic-id-namespace.test.ts`.
- Wajib: skenario SO persis; replay dan urutan berbalapan; tenant lain; assert uang (tidak ada panggilan payout kedua, refund baru 409/422, fact total <= uang nyata).
- Jalankan dari ROOT worktree: `LEGEND_TEST_FILES="src/test/<berkas>" heavy pnpm test`. Satu run per berkas per putaran. Jangan edit kode service.
- Gagal-dulu di base: worktree base `.worktrees/base-1045` (detached c118f02a5) disiapkan koordinator; salin berkas test ke sana dan jalankan dari root base dengan perintah yang sama.
- Laporan: daftar test, gagal di base + pesan (1 baris), asumsi.

## Explore

Laporan ringkas (<= 60 baris): file:line, tabel/kolom, lock dan urutannya, pemanggil, test lama yang mengunci perilaku, usul perbaikan minimal dan risikonya.

### F1 revisi (koordinator, setelah implementasi)
- DOIT hanya punya status pending/paid/expired/failed/refunded, tanpa partial: `paid` tidak membuktikan provider tidak me-refund sebagian. Jadi poller TIDAK menutup hold `own_refund_failed_unverified` otomatis. Poller hanya: jawaban `refunded` -> jalur markProviderRefunded (fact sisa), hold tetap. Semua hold ini ditutup finance (resolve `not_this_intent` setelah cek dashboard provider, atau `counted_against_intent`).
- Test: kontrol "paid" menjadi: poller jawab paid -> hold tetap; finance resolve not_this_intent -> refund baru berjalan sekali (satu payout).

## Matriks race (CTO Retro 46)

Invarian tiap test (wajib, assert eksplisit): UANG KELUAR <= DIBAYAR, dengan
uang keluar = jumlah payout gateway palsu yang berhasil (refund kita completed) + refund yang dilakukan provider sendiri (doit.refund / laporan provider) + kredit DP yang dipakai sesi lain dari intent itu (bila ada); dibayar = nominal transaksi lunas. Plus: fact provider total <= dibayar, refund baru sesudah laporan provider ditolak 409/422 atau tidak menghasilkan payout. Satu test per skenario, urutan dipaksa dengan barrier/await (bukan sleep); varian dua urutan bila disebut.

### Berkas M1 `apps/api/src/test/refund-1045-d-race-report.test.ts` (laporan x refund kita x refund baru)
- M1-01 webhook status penuh tiba saat R live ber-ref -> R gagal -> refund baru -> replay.
- M1-02 sama, R completed -> replay -> refund baru.
- M1-03 webhook tiba saat R in-flight tanpa ref -> R gagal sebelum worker -> refund baru -> worker replay.
- M1-04 poller (tanpa webhook) provider sudah refund, R gagal -> refund baru sebelum poller -> poller -> refund baru lagi.
- M1-05 webhook dan poller bersamaan (Promise.all) saat R live, lalu R gagal; dua urutan R gagal vs laporan.
- M1-06 laporan refund ID provider (bukan status) sebagian 40k saat R 100k live -> R gagal -> refund baru 60k dan 100k.
- M1-07 webhook ganda (dua event id) + R gagal berbalapan dengan worker replay (Promise.all), dua urutan.
- M1-08 tanpa refund kita: provider refund 100k via webhook -> refund baru (kontrol: ditolak).

### Berkas M2 `apps/api/src/test/refund-1045-e-race-resolve-credit.test.ts` (resolve hold x kredit DP x refund baru)
- M2-01 hold live_own terbuka, finance resolve counted_against_intent bersamaan dengan R gagal (dua urutan) -> refund baru.
- M2-02 hold terbuka, finance resolve not_this_intent bersamaan dengan R completed -> refund baru.
- M2-03 hold own_refund_failed_unverified (R gagal) -> finance resolve not_this_intent -> refund baru sekali; lalu webhook terlambat provider refunded -> tidak ada payout lagi, fact tercatat.
- M2-04 intent DP reservasi: laporan provider refunded saat apply kredit DP ke sesi lain berjalan (barrier, dua urutan) -> total kredit + refund provider <= DP.
- M2-05 DP: R (refund DP) gagal, apply kredit DP sebelum finance resolve -> kredit ditolak/dibatasi; sesudah resolve counted -> tidak ada kredit dari uang yang sudah direfund provider.
- M2-06 DP: refund baru DP dan apply kredit DP bersamaan saat hold terbuka -> keduanya tertahan.
- M2-07 resolve hold ganda bersamaan (dua request) -> satu fact.

Pola fixture: refund-1035-a, refund-1045-a/-b, reservation-deposit-dp-pool-1033, refund-1033-xmtih-hold-lock, refund-1025c-b-credit-vs-provider-refund. Skenario yang ternyata TIDAK aman: biarkan assert uang ketat (test merah) dan laporkan dengan bukti angka; jangan longgarkan.

## Temuan architect xhigh (wajib)
- **A1 (P1) hold nominal 0 macet.** payment-provider-partial-refund.ts ~468-473: `inFlight` dihitung untuk seluruh intent, `live` hanya untuk transaksi yang dilaporkan. Skenario: intent 2 transaksi; refund dana parkir T2 berjalan tanpa ref; status `refunded` transaksi utama T1 tiba -> hold synthetic_full nominal 0 + retry; lewat 15 menit force mencatat fact sambil refund masih berjalan, hold tidak tertutup; finance: counted 422 (nominal <= 0, refund-recon-hold.service.ts ~296), not_this_intent ditolak untuk synthetic -> intent terblokir selamanya. Perbaikan: nominal hold minimal sisa berisiko transaksi itu (`left`); countHold tidak menolak nominal <= 0 untuk synthetic_full (atau tutup tanpa fact baru bila fact sudah ada). Assert: finance selalu punya jalan keluar, uang keluar <= dibayar.
- **A2 (P1) fact provider dua kali.** Hold F1 tanpa refund id (refund-recon-hold.service.ts ~653); jalur kind `provider` di perekam hanya menolak bila ada synthetic_full (~513), tanpa batas sisa. Skenario: R 100k terkirim lalu gagal -> hold F1; finance resolve counted -> fact synthetic_hold 100k; echo R terlambat dengan refund id P 100k -> R failed, dianggap bukan milik kita -> fact provider 100k lagi -> total fact 200k atas bayaran 100k. Perbaikan: (a) hold F1 menyimpan R.providerRef sebagai provider_refund_id kind `provider` bila ada (resolve counted mencatat fact dengan id itu, sehingga echo jadi duplikat); (b) jalur kind provider tidak boleh mencatat melebihi sisa transaksi (bayar - fact yang ada); kelebihannya jadi hold untuk finance, tanpa fact. Assert: fact total <= dibayar, tidak ada payout kedua.
- **A3 (P2) hold F1 tanpa alert.** Kirim alert yang sama dengan hold live_own saat hold F1 baru dibuat (hanya bila baris baru).
- **A4 (P2) penutupan hold pada duplikat** (~559) harus memastikan fact yang ada milik intent + tenant yang sama.
- Dicatat saja: migrasi 0656 `payment:foo` lama + laporan refund id transaksi sama (belum ada production); hold retry provider yang ternyata duplikat synthetic_full hanya bisa not_this_intent (label).

Test merah-dulu: `apps/api/src/test/refund-1045-f-architect.test.ts`, A1-01..(dua transaksi, T2 berjalan, T1 refunded, lewat force window, finance resolve -> jalan keluar ada; uang <= dibayar), A2-01..(R gagal -> resolve counted -> echo terlambat ber-id P -> fact total 100k; varian: echo dulu, resolve kemudian; varian: tanpa ref, provider report melebihi sisa -> hold, bukan fact), A3-01 alert sekali, A4-01 duplikat fact intent lain tidak menutup hold.

## Regresi 139 berkas (19 berkas gagal, 11 test + teardown FK)

Log: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-3312339e/5955fba2-d638-4ed4-8b4a-539728b7a7cb/tasks/bp381p7ut.output
- FAIL  src/test/payment-doit-partial-refund-967.test.ts [ src/test/payment-doit-partial-refund-967.test.ts ]
- FAIL  src/test/payment-doit-recon-remainder.test.ts [ src/test/payment-doit-recon-remainder.test.ts ]
- FAIL  src/test/payment-doit-refund-facts-invalid.test.ts [ src/test/payment-doit-refund-facts-invalid.test.ts ]
- FAIL  src/test/payment-doit-refund-webhook-disabled.test.ts [ src/test/payment-doit-refund-webhook-disabled.test.ts ]
- FAIL  src/test/payment-doit-refund-webhook-plan-revoked.test.ts [ src/test/payment-doit-refund-webhook-plan-revoked.test.ts ]
- FAIL  src/test/payment-doit-refund-webhook.test.ts [ src/test/payment-doit-refund-webhook.test.ts ]
- FAIL  src/test/payment-doit-refunded-after-paid-958.test.ts > legend-7uqbs a declined fund refund does not free the money when the provider refunded > 958-a9 control: a declined fund refund with NO provider refund frees the money (the fund can be requested again)
- FAIL  src/test/payment-doit-refunded-hold-release.test.ts > legend-3wpf/952 r2 verified DOIT refunded and paid webhooks
- FAIL  src/test/payment-doit-refunded-late-paid.test.ts [ src/test/payment-doit-refunded-late-paid.test.ts ]
- FAIL  src/test/payment-poll-lease.test.ts [ src/test/payment-poll-lease.test.ts ]
- FAIL  src/test/payment-refund-approval.test.ts > PAY-04 provider failures > PAY-04 a definitive provider decline fails the refund and frees the amount
- FAIL  src/test/payment-refund-approval.test.ts [ src/test/payment-refund-approval.test.ts ]
- FAIL  src/test/payment-refund-codex-fix.test.ts [ src/test/payment-refund-codex-fix.test.ts ]
- FAIL  src/test/payment-refund-manual-settle-webhook.test.ts [ src/test/payment-refund-manual-settle-webhook.test.ts ]
- FAIL  src/test/payment-supersede-doit.test.ts [ src/test/payment-supersede-doit.test.ts ]
- FAIL  src/test/payment-terminal-paid.test.ts > the poller with unusual DOIT answers > a gateway error (drop) leaves the intent pending and the round goes on
- FAIL  src/test/payment-terminal-paid.test.ts > the poller with unusual DOIT answers > a gateway error (http500) leaves the intent pending and the round goes on
- FAIL  src/test/payment-terminal-paid.test.ts [ src/test/payment-terminal-paid.test.ts ]
- FAIL  src/test/payment-webhook-api.test.ts > PAY-02 a gateway error never closes a lapsed intent > PAY-02 DOIT still pending past expiry keeps the intent pending; a later paid answer settles it
- FAIL  src/test/payment-webhook-api.test.ts > PAY-02 a gateway error never closes a lapsed intent > PAY-02 a gateway error past expiry keeps the intent pending; the guest sees it expired; a later poll settles it
- FAIL  src/test/payment-webhook-api.test.ts > PAY-02 a gateway error never closes a lapsed intent > PAY-02 a settlement that fails with a non-rejection error past expiry keeps the intent pending; the next poll settles it
- FAIL  src/test/payment-webhook-api.test.ts [ src/test/payment-webhook-api.test.ts ]
- FAIL  src/test/qr-order-late-refund-after-failed.test.ts > QR order late refund after the committed refund failed (legend-p61pe) > QR-LATE-REFUND-P4 the refund filed after R failed also fails: no third refund
- FAIL  src/test/qr-order-late-refund-after-failed.test.ts > QR order late refund after the committed refund failed (legend-p61pe) > QR-LATE-REFUND-P5 a replacement late refund approved while another staff refund is still pending is not failed cap_exceeded
- FAIL  src/test/refund-1025-b-full-refund-journal.test.ts > 1025-B a forced full-refund write with our refund still in flight files a recon hold > 1025-B-F3 R in flight, the retry window passes, the worker forces the write: the row, one open hold and one extra alert exist together; a replay adds none
- FAIL  src/test/system-refund-followup.test.ts > legend-weuo2 weuo2-F a provider decline is not re-filed (CTO 15 Nov) > weuo2-F the provider declines the system refund: no new refund, one alarm, one audit row, listed as failure_needs_person, money capped
    Serialized Error: { length: 380, severity: 'ERROR', code: '23503', detail: 'Key (id)=(289e4f55-df00-4818-8757-a01e63de408f) is still referenced from table "payment_intents".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'payment_intents', dataType: undefined, constraint: 'payment_intents_gateway_integration_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70, 4efad3e3-0e36-4435-a1ee-83b612ffe5c3) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70, 9eca8146-ca4f-4c9e-b43e-446250a89785) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70, c618cf8f-babd-4a0a-932b-7d29741a38a8) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70, c8ceaa1e-96f8-43eb-bbce-e02d6ba00eec) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70, fafe0ea0-e6b6-451a-8ab3-61cbd5289de6) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(1e4b0ce4-62da-4337-aa4c-eaeb0259ee86, 1168b742-361e-5f48-968a-28ed3306e63b) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }
    Serialized Error: { length: 412, severity: 'ERROR', code: '23503', detail: 'Key (tenant_id, id)=(f4a7c4f8-2106-4637-afc0-603b824d83e5, efe779b9-71c9-493d-9b3d-2d7a1f06b6e4) is still referenced from table "refund_recon_holds".', hint: undefined, position: undefined, internalPosition: undefined, internalQuery: undefined, where: undefined, schema: 'public', table: 'refund_recon_holds', dataType: undefined, constraint: 'refund_recon_hold_intent_fk', file: 'ri_triggers.c', routine: 'ri_ReportViolation' }

### Analisis regresi (implementer F1)
- Poller "round goes on" + PAY-02: bukan bug produk; sisa intent dari teardown gagal (FK hold) di tenant bersama membuat fake DOIT error duluan. Sudah: DELETE refund_recon_holds (+ payment_provider_refunds) di teardown 11 berkas (967, recon-remainder, facts-invalid, refund-webhook(-disabled/-plan-revoked), refunded-late-paid, refund-approval, codex-fix, manual-settle-webhook, webhook-api) + 958-a9 disesuaikan.
- Sisa:
  - R1 (disengaja, hold F1 sesudah refund terkirim lalu gagal): payment-refund-approval PAY-04, qr-order-late-refund-after-failed P4/P5. Ubah: assert 409 + satu hold own_refund_failed_unverified; finance resolve not_this_intent (route) -> 200/201 dan sisa assert asli (uang, jumlah payout) tetap.
  - R2 (belum dianalisis): system-refund-followup weuo2-F (`length 1 got 2`), refund-1025-b-full-refund-journal 1025-B-F3 (`deeply equal []`, kemungkinan hold F2/F1). Tentukan: disengaja -> sesuaikan tanpa melonggarkan uang; bug -> laporkan dengan skenario, jangan ubah service.
  - Berkas lain dengan teardown FK (payment-doit-refunded-hold-release, payment-terminal-paid, payment-poll-lease, payment-supersede-doit): cek apakah butuh DELETE refund_recon_holds juga.
