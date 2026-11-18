# Brief subagent 1035: perbaikan SO refund ronde 2

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-3312339e` (cabang base 6075e2bb6 = 1025 + 1033). Tingkat K (uang).
Sumber skenario lengkap: `docs/qa/second-opinion-refund-ronde2-1034.md` (temuan 1-5). Ronde 1: `docs/qa/second-opinion-refund-area-1032.md`.
Riwayat keputusan: `docs/PROGRESS.md` bagian 1025, 1025b, 1025c, 1025d, 1033, 1033b (baris ~7080-7145).

Aturan uang (founder): tamu tidak dibayar lebih, outlet tidak rugi, jurnal = uang nyata. Ragu: pilih yang membatasi pembayaran (hold/tolak), jangan yang membuka payout.

## Temuan

- **A / legend-04izi (P1, temuan 1).** `apps/api/src/services/payment-provider-partial-refund.ts` ~369-422: refund sendiri live dengan `provider_ref` dianggap pasti sukses, return `own` tanpa fact/stamp/hold. `provider_ref` disimpan pada jawaban pending (`payment-refund.service.ts` ~2653-2667), bisa jadi failed; `failRefund` (~683-701) tidak menemukan stamp/fact/hold, fund bisa direfund ulang. Target: refund live (ber-ref atau tidak) yang dipakai sebagai pengurang = in-flight: hold sampai final; gagal -> catat fact sisa sebelum hold ditutup; sukses -> tutup hold tanpa catat dobel.
- **B / legend-yn1of + legend-uvjqq (P1, temuan 2+3).** ID refund sintetis `payment:<ref>` / `payment:h:<sha256>` (`payment-provider-partial-refund.ts` ~70-73, ~336-433, ~461-469) bertabrakan dengan ID pembayaran pendek `h:<64hex>` dan dengan ID refund provider asli berawalan `payment:` (`payment-doit-refund-webhook.ts` ~74-85, ~136-140 menerima string bebas 1-100). Resolve hold `isHashedSyntheticRefundId` (`refund-recon-hold.service.ts` ~365-373). Duplicate di webhook `payment-webhook.service.ts` ~988-991. Target: discriminator eksplisit (kolom mis. `source` = `provider` | `synthetic_full`) pada tabel fact refund provider (dan hold bila perlu), unique key memakai source, cabang dipilih dari source bukan prefix string. Migrasi nomor 0656-0657, backfill baris lama aman.
- **C / legend-8cm5k (P2, temuan 4).** `apps/api/src/services/reservation-deposit-remainder.ts` ~485-655: candidates dikunci + divalidasi, lalu SELECT kedua bisa memasukkan remainder baru yang tidak divalidasi (receipt belum posted / direverse). Finalisasi sesi lain membuat remainder tanpa lock `reservation-credit` (~190-201, ~298-315). Target: satu pembacaan di bawah lock (pembacaan kedua dibatasi ke kandidat yang sudah dikunci+divalidasi), atau finalisasi juga ambil lock reservation-credit. Juga `reservation-deposit-credit.ts` ~267-299, ~384-398.
- **D / legend-2hl7y (P2, temuan 5).** `apps/api/src/services/accounting-auto-journal-amounts.ts` ~2605-2620 memanggil `providerRefundedForeignIdrSql` (`payment-provider-refunded-foreign-sql.ts` ~38-58) dengan filter satu row; guard harus memakai total kumulatif refund kelompok evidence vs dana parkir. Skenario: evidence 140k (100k tagihan + 40k parkir), dua refund provider 30k+30k: tiap event harus dijurnal sesuai uang nyata (atau ditahan dengan jalur finance), tidak ditolak `AutoJournalPayloadInvalid` keduanya.

## Test (test-writer)

- Berkas baru, satu per temuan: A `apps/api/src/test/refund-1035-a-pending-ref-own.test.ts`, B `apps/api/src/test/refund-1035-b-synthetic-id-namespace.test.ts`, C `apps/api/src/test/reservation-deposit-remainder-recheck-1035.test.ts`, D `apps/api/src/test/accounting-refund-split-cumulative-1035.test.ts`.
- Contoh pola fixture: `refund-1025d-a-secondary-transaction.test.ts`, `refund-1025d-b-long-payment-id.test.ts`, `refund-1033-xmtih-hold-lock.test.ts`, `reservation-deposit-dp-pool-1033.test.ts`, `accounting-auto-journal-refund-split.test.ts`, `accounting-provider-refund-net-1013.test.ts`.
- Wajib: skenario SO persis; event ganda/replay dan urutan berbalapan (webhook vs poller, dua urutan); tenant lain tidak terpengaruh; assert uang (fund tidak bisa dipayout ulang, total kredit/refund <= uang nyata, jurnal = uang nyata). Uji perilaku lewat service/route publik, bukan nama kolom (kecuali B: boleh assert tidak ada tabrakan unique).
- Gagal-dulu karena sebab yang benar (bukan setup/422). Jalankan: `cd "/Users/ifanshori99/Projects/legend super app/legend-3312339e/apps/api" && LEGEND_TEST_FILES="src/test/<berkas>" heavy pnpm test` (dari root worktree: `LEGEND_TEST_FILES="apps/api/src/test/..."` bila perlu; cek README test). Satu run per berkas. Jangan edit kode service.
- Laporan: daftar test, mana gagal di base dan pesan gagalnya (1 baris tiap), asumsi nilai yang diharapkan.

## Explore

Laporan ringkas (<= 60 baris): jalur kode tepat (file:line), tabel/kolom/unique index terkait, lock yang diambil dan urutannya, pemanggil, test lama yang mengunci perilaku ini, dan usul perbaikan minimal dengan risiko.

## Desain yang diputuskan (implementer)

### A + B (satu implementer, Opus; file: db/schema/payment.ts, db/schema/refund-recon-holds.ts, drizzle 0656, payment-provider-partial-refund.ts, refund-recon-hold.service.ts, payment-webhook.service.ts, poller/markProviderRefunded, payment-doit-refund-webhook.ts, pembaca lain providerRefundId KECUALI accounting-auto-journal-amounts.ts)
- Kolom baru `payment_provider_refunds.refund_id_kind` (TS `refundIdKind`) varchar(20) NOT NULL DEFAULT 'provider', CHECK IN ('provider','synthetic_full','synthetic_hold'). Unique jadi (tenant_id, provider, refund_id_kind, provider_refund_id).
- synthetic_full: status `refunded` transaksi; `provider_refund_id` = ref pembayaran mentah (tanpa prefix, tanpa hash). synthetic_hold: fact dari resolve hold tanpa id; `provider_refund_id` = uuid hold. provider: ID refund provider asli apa adanya (boleh berawalan `payment:`/`hold:`/`h:`).
- `refund_recon_holds`: kolom `provider_refund_id_kind` (nullable, wajib terisi bila provider_refund_id terisi, CHECK), unique parsial jadi (tenant, intent, kind, provider_refund_id). Kunci dedup hash live_own ikut kind.
- `ProviderRefundInput` dapat `refundIdKind` wajib; semua cabang pilih dari kind, bukan `startsWith`. Hapus `SYNTHETIC_PREFIX`/`isHashedSyntheticRefundId` dari logika keputusan (resolve hold pakai kind + provider_payment_ref).
- Semua cek echo "refund kita ber-provider_ref = provider_refund_id" (SQL dan TS, termasuk `payment-provider-refunded-foreign-sql.ts` dan `accounting-auto-journal-guards.ts`) wajib dibatasi ke kind='provider'. Audit semua `provider_refund_id`/`providerRefundId` (grep) dan sebut di laporan.
- Migrasi 0656 (nama `0656_provider_refund_id_kind`): db:generate lalu ubah nama file/tag/snapshot ke 0656 bila generator memberi nomor lain; backfill di SQL yang sama: fact dengan id = 'payment:'||provider_payment_ref atau 'payment:h:'||encode(sha256(convert_to(provider_payment_ref,'UTF8')),'hex') -> synthetic_full, id = provider_payment_ref; id '^hold:<uuid>$' yang uuid-nya hold tenant sama -> synthetic_hold, id = uuid. Hold: sama (hold lama tanpa provider_payment_ref: ref = substring setelah 'payment:'). Sisanya provider. Pindahkan FK ke CREATE TABLE tidak relevan (tidak ada tabel baru). db:generate setelahnya harus kosong.
- A (04izi): di cabang synthetic_full `left <= 0` dengan `live.length > 0`: SELALU fileLiveOwnHold (ber-ref atau tidak, force atau tidak), kecuali cabang retry lama untuk refund tagihan tanpa ref yang belum force. Tidak ada `own` tanpa hold bila ada refund kita live. Finance resolve `counted_against_intent` setelah refund kita failed harus mencatat fact sekali; setelah completed tidak menambah fact.
- Test lama yang memakai `payment:<ref>` sebagai id tersimpan boleh disesuaikan (catat berkas mana dan alasannya).

### C (implementer; file: reservation-deposit-remainder.ts saja, reservation-deposit-credit.ts bila perlu)
- SELECT kedua FOR UPDATE dibatasi ke id kandidat SELECT pertama yang sudah dikunci+divalidasi (`id IN (...)`); remainder baru diabaikan pada apply ini. Jangan tambah lock reservation-credit di finalisasi (urutan lock terbalik = deadlock). Periksa juga pembacaan kredit tujuan tidak memakai pool sumber yang tidak tervalidasi.

### D (implementer; file: accounting-auto-journal-amounts.ts saja)
- Di ~2605: `onlyIf` = baris kelompok evidence yang sama (`pr.evidence_id IS NOT DISTINCT FROM <evidence row ini>`) DAN `(pr.created_at, pr.id) <= (<created_at row ini>, <id row ini>)`. counted > 0 -> jurnal nominal row ini sendiri; counted = 0 -> tetap AutoJournalPayloadInvalid. Pastikan jumlah jurnal = nominal row, bukan `counted`. Jangan ubah `payment-provider-refunded-foreign-sql.ts`.
- Cek echo ~2575 (`paymentRefunds.providerRef = refund.providerRefundId`): hanya bila `refund.refundIdKind === 'provider'` (kolom ditambah implementer B di schema payment.ts; baca saja, jangan edit schema).

## Perbaikan E (celah poller, ditemukan test 1035-04izi-07 poller)

Skenario: refund tagihan kita R Rp100.000 live ber-ref; poller melihat transaksi `refunded` -> `markProviderRefunded` tanpa force -> recorder `retry` (B1), tanpa hold/fact. R lalu failed. Sebelum replay, refund penuh baru dibuat (201), disetujui (200), gateway palsu menerima payout kedua = tamu dibayar dua kali. Varian webhook aman (hold ada).
Target: di jalur yang menandai refund kita `failed` (failRefund dan semua jalur lain yang menulis status failed, mis. applyRefundProviderUpdate), dalam transaksi yang sama dan di bawah urutan lock yang benar (intent row -> deposit-intent exclusive, lihat fileLiveOwnHold): bila transaksi refund itu sudah dilaporkan refunded oleh provider (stempel intent providerRefundedAt/providerRefundedAfterPaidAt untuk transaksi utama, atau stempel fund providerRefundedAt untuk transaksi tambahan) dan belum ada fact refund provider yang menutup sisa transaksi -> ajukan hold refund_recon (live_own, kunci dedup stabil, sekali) sehingga refund/payout intent terblokir sampai finance resolve (`counted_against_intent` mencatat fact sekali). Alternatif yang lebih tepat boleh: panggil recordProviderRefundInTx untuk status synthetic_full transaksi itu (mencatat fact sisa) bila nominal pasti. Pilih yang paling sederhana dan aman; jangan auto-close hold.
Bukti: `refund-1035-a-pending-ref-own.test.ts` -07 (poller) harus lulus; seluruh berkas 1035-a dan -b lulus.
