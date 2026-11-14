# Sub-brief 740: wiring UI payout (legend-gthgq)

Worktree: `.worktrees/payout-wiring` (cabang ui/payout-wiring = ui/payout-finance-exceptions + ws/payout-api-gaps).
UI disetujui founder (Q23): jangan ubah desain; hanya wiring + keadaan hilang.
Web: `apps/web/src/features/ws10-payroll-payout/`, route `apps/web/src/routes/_kelola/kelola.payroll.pencairan.tsx`.
Kontrak: `packages/shared/src/hris/payroll/payout-endpoints.ts`, `packages/shared/src/validators/payroll-payout.ts`, `packages/shared/src/types/api.ts`.
API: `apps/api/src/routes/*payout*`, `apps/api/src/services/*payout*`, tests `apps/api/src/test/payroll-payout-{batch-list,evidence-upload,item-snapshot}.test.ts`.
Mock e2e: `e2e/payout.mock.spec.ts`. Teks: `packages/shared/src/i18n/messages/ws10-payroll-payout*.ts`, kontrak `tests/text-contract.test.mjs`.

## Area A — snapshot rekening (P1 uang)
`components/approval-items.tsx:~42` sekarang pakai profil HR (/employees/:id/pii). Ganti ke item.accountHolderName + item.maskedAccountNumber. Item bank tanpa snapshot (null, bukan cash): teks "Rekening belum tercatat di batch", dan batch tidak bisa disetujui (blokir tombol setujui + alasan). Hapus query pii bila tak dipakai lagi.

## Area B — unggah bukti
POST /api/hris/payroll/disbursement-batches/:id/evidence (multipart `file`, JPEG/PNG/PDF, 5 MiB, step-up MFA, payroll.disburse.approve) -> {data:{evidenceKey,contentType,sizeBytes}}. Aktifkan pilihan Gagal/Tidak terkirim + return di `status-dialogs.tsx` dengan unggah bukti; kirim evidenceKey ke resolve/return. PDF: server 503 sementara -> pesan "Unggah foto atau screenshot bukti". Input file accept JPEG/PNG saja.

## Area C — daftar batch per PT
Ganti N request per run (runs-tab/payout-page/hooks) dengan GET /api/hris/payroll/payout-batches?legalEntityId&status&cursor&limit(<=20), paginasi (useInfiniteQuery / "Muat lagi").

## Aturan
Semua teks UI baru di katalog i18n. Komponen hanya pakai hooks. Jangan jalankan tsc/vitest/playwright (token heavy dipegang agent). Jangan commit.

## Teks (SUDAH ditambah agent; jangan tambah kunci baru tanpa perlu, bila perlu tambah di file area sendiri)
- `payrollPayoutReview.common.noSnapshot`, `payrollPayoutReview.approval.blocked.noSnapshot` ({count})
- `payrollPayoutReview.result.{evidenceFile,evidenceFileHint,evidenceFileRequired,note,noteHint,noteRequired,resolveWarning,proposed,resolved,uploading,returnTitle,returnDescription({name},{amount}),returnAction,returnSubmit,returnProposed,returnDone}`
- `payrollPayoutReview.error.{evidencePhotoOnly,evidenceTooLarge,evidenceRejected,evidenceUnavailable,resolveSamePerson,resolveOutcomeMismatch}`
- `payrollPayout.runs.{loadMore,loadingMore}`
- Hapus pemakaian `result.evidenceUnavailableTitle/evidenceUnavailable` (biarkan kunci di katalog; I3 hapus bila tak dipakai).

## Kontrak antar potongan (I1 menyediakan, I2–I4 memakai)
- shared `payout-endpoints.ts`: `listPayoutBatches` (GET `${BASE}/payout-batches`, query listPayoutBatchesQuerySchema, response `{data: payoutBatchSchema[], meta:{limit,nextCursor: string|null}}`), `returnDisbursementItems` (POST `${BASE}/disbursement-batches/:id/return`, body returnManualItemsSchema; cek response di route API), konstanta path evidence `PAYOUT_EVIDENCE_UPLOAD_PATH`.
- web `api.ts`: `fetchPayoutBatches(query)`, `uploadPayoutEvidence(batchId, file)` (FormData `file`, pola `features/hris-requests/leave-upload.ts`, error -> ApiError), `postReturnItems(batchId, body)`. Mock (API_MOCK): evidence upload -> `{evidenceKey:"tenants/mock/payroll-payout/<batchId>/evidence/mock.png",...}`; nama berkas `*.pdf` -> ApiError 503 `SERVICE_UNAVAILABLE`.
- web `hooks.ts`: `useEntityBatches(legalEntityId, opts)` bentuk lama TETAP (`entries:{run,batches}[]`, isPending, isError, refetch) + `hasNextPage`, `fetchNextPage()`, `isFetchingNextPage`; sumber `useInfiniteQuery(listPayoutBatches, legalEntityId, limit 20)`, digabung dengan runs per runId. `useUploadPayoutEvidence()` mutate({batchId,file}) -> PayrollPayoutEvidenceUploadDto. `useReturnBatch()` mutate({batchId,itemIds,evidenceKey,note,password?}). Invalidasi juga key list baru. `usePayoutEmployees` tanpa bankLabel/pii (hapus `bankLabelQuery`, `fetchPayeeBankLabel`).
- `mock.ts`: item factory isi `accountHolderName` (nama karyawan) + `maskedAccountNumber:"****1234"` utk bank, null utk cash. Skenario baru: `mock=legacy-account` (batch pending approval, 1 item manual_bank snapshot null), `mock=batches-paged` (list 2 halaman: halaman 1 nextCursor "p2"). Mock list + return terdaftar.
- Kode error web (`errors.ts`, I3): 503 SERVICE_UNAVAILABLE pada upload -> `error.evidencePhotoOnly` bila berkas PDF, selain itu `error.evidenceUnavailable`; 413 -> evidenceTooLarge; 415/422 PAYOUT_EVIDENCE_REJECTED -> evidenceRejected; PAYOUT_RESOLVE_SAME_PERSON / PAYOUT_RESOLVE_OUTCOME_MISMATCH.

## Potongan
- I1 data: `packages/shared/src/hris/payroll/payout-endpoints.ts`, `apps/web/src/features/ws10-payroll-payout/{api,queries,hooks,mock}.ts`.
- I2 approval (Area A): `components/approval-items.tsx`, `components/approval-tab.tsx`, `components/approval-summary.tsx`. Baris rekening: `accountHolderName · maskedAccountNumber` + bankLabel dari bankCode bila ada; cash: perilaku lama; bank + snapshot null: `common.noSnapshot` dengan tanda peringatan. blockKey baru `noSnapshot` (prioritas setelah noPermission), tombol setujui nonaktif + alasan.
- I3 status (Area B): `components/status-dialogs.tsx`, `components/status-items.tsx`, `components/status-tab.tsx`, `errors.ts`. Radio Gagal/Tidak terkirim aktif; bila dipilih: input file (accept="image/jpeg,image/png"), catatan, peringatan; submit = upload lalu resolve (step-up lewat useStepUp yang ada; retry upload setelah verifikasi). Return: item manual_bank `succeeded` -> aksi `returnAction` di dialog rincian/bukti -> dialog return (file+catatan) -> upload lalu return. Tampilkan `proposed`/`resolved` dari respons. PDF dipilih: tolak di klien juga dengan `error.evidencePhotoOnly`.
- I4 daftar (Area C): `components/runs-tab.tsx`, `components/payout-page.tsx`. Tombol "Muat lagi" (`runs.loadMore`) bila hasNextPage, nonaktif + `runs.loadingMore` saat memuat.
- T test-writer: `e2e/payout.mock.spec.ts` test baru (mock skenario di atas): A snapshot tampil + legacy diblokir; B pilih Gagal -> unggah PNG -> catatan -> simpan -> pesan proposed; PDF -> pesan "Unggah foto atau screenshot bukti"; C batches-paged -> "Muat pencairan berikutnya" memuat halaman 2. Jangan jalankan Playwright (agent yang menjalankan).

## Putaran 2 — temuan reviewer (wajib)
F1 (`hooks.ts`, `mock.ts`, bila perlu `e2e/payout.mock.spec.ts` test C): batch open di halaman 2 tak terlihat -> run tampak tanpa batch, tab Persetujuan kosong. Aturan: di `useEntityBatches`, auto `fetchNextPage` (efek) selama `hasNextPage` dan batch tertua yang dimuat `createdAt >= ` lockedAt tertua (fallback periodStart) dari run yang ditampilkan (termasuk paid bila includePaid), maks 10 halaman. Batch selalu dibuat setelah run dikunci, jadi setelah itu semua batch run yang tampil sudah termuat. "Muat lagi" tetap untuk riwayat lebih lama. Sesuaikan skenario `batches-paged` supaya halaman 2 berisi batch lebih tua dari semua lockedAt (tombol tetap muncul) dan test C tetap bermakna; tambah satu test: skenario dengan batch pending_approval di halaman 2 untuk run yang ditampilkan -> tab Persetujuan tetap membuka batch itu (nama skenario `batches-paged-open`).
F2 (`components/status-dialogs.tsx`, `errors.ts`, `components/approval-items.tsx`, i18n `ws10-payroll-payout-review.ts`):
- Upload bukti hanya menerima step-up MFA (tanpa password). Dialog resolve/return: `useStepUp({ acceptsPassword: false })` supaya tidak loop.
- Map `PAYOUT_RETURN_EVIDENCE_MISMATCH` -> kunci baru `error.returnEvidenceMismatch` ("Orang kedua harus memakai bukti yang sama dengan orang pertama. Layar ini belum bisa melakukannya; hubungi tim teknis. Tidak ada dana yang dicatat kembali."), `PAYOUT_RETURN_SAME_PERSON` -> `error.returnSamePerson` ("Konfirmasi kedua harus dilakukan orang lain, bukan orang yang mencatat pertama.").
- `result.returnProposed` jadi: "Usulan tercatat. Orang kedua perlu mengonfirmasi dengan bukti yang sama."
- ExcludedList: jangan tampilkan peringatan no-snapshot untuk item dikecualikan (pakai teks lama).

## Putaran 3 — temuan ui-auditor
G1 (`hooks.ts`, `components/runs-tab.tsx`, i18n `ws10-payroll-payout.ts`): gagal "Muat lagi" tidak boleh mengganti seluruh tab dengan error. `useEntityBatches.isError` hanya untuk kegagalan halaman pertama/runs (`list.isError && !list.isFetchNextPageError`); ekspos `loadMoreError: boolean` (= isFetchNextPageError). Runs-tab: di dekat tombol tampilkan teks inline kunci baru `runs.loadMoreError` ("Pencairan berikutnya gagal dimuat. Coba lagi.", role="alert"), tombol tetap bisa diklik untuk mencoba lagi. Pastikan auto-fetch tidak mengulang saat loadMoreError.
G2 (`components/status-dialogs.tsx`, i18n `ws10-payroll-payout-review.ts`):
- `ProofFields` dapat prop `variant: "resolve" | "return"`. Return memakai kunci baru `result.returnFileHint` ("Foto atau screenshot bukti dana masuk kembali dari bank (JPG atau PNG, maks 5 MB). Item tetap tercatat dibayar sampai dua orang berbeda mencatat dana kembali.") dan `result.returnWarning` ("Dana kembali membalik catatan pembayaran gaji ini. Jangan bayar ulang sebelum dua orang mencatatnya.").
- `role="status"` peringatan: hanya di ResultDialog saat muncul setelah ganti pilihan; hapus di ReturnDialog.
- Ubah `approval.blocked.noSnapshot` jadi: "{count} karyawan transfer bank belum punya rekening tercatat di batch ini, jadi pengajuan ini tidak bisa disetujui. Hubungi tim teknis untuk membatalkan lalu mengajukan ulang."

## Putaran 4 — usulan langkah-1 (cabang ws/payout-evidence-hardening sudah di-merge)
API baru (lihat `packages/shared/src/types/api.ts` PayrollPayoutEvidenceReadDto, PayrollPayoutProposalDto; validator payoutEvidenceReadQuerySchema; routes `apps/api/src/routes/payroll-payout-evidence.routes.ts`):
- `GET ${BASE}/disbursement-batches/:id/evidence?key=` -> `{data:{evidenceKey,url,expiresAt}}` (signed URL 60 detik, tanpa step-up).
- `GET ${BASE}/disbursement-batches/:id/resolution-proposals` -> `{data: PayrollPayoutProposalDto[]}` (kind resolve|return, outcome failed|not_sent|null, evidenceKey, note, proposedBy userId, proposedAt).
- Langkah 2 resolve DAN return wajib evidenceKey SAMA dengan usulan; beda -> 409 `PAYOUT_RESOLVE_EVIDENCE_MISMATCH` / `PAYOUT_RETURN_EVIDENCE_MISMATCH`.
- Serah terima tunai: jangan kirim evidenceKey (pastikan).

H1 data (`payout-endpoints.ts`, `api.ts`, `queries.ts`, `hooks.ts`, `mock.ts`): endpoint `readPayoutEvidence`, `listResolutionProposals`; `useResolutionProposals(batchId)` (map itemId -> proposal; invalidasi bersama refresh payout); `useOpenPayoutEvidence()` mutation({batchId,key}) -> url (ambil saat diklik, URL 60 detik; jangan cache). Mock: skenario `mock=resolve-proposal`: batch exported 202 punya usulan resolve (failed, evidenceKey mock milik batch, note, proposedBy user lain bukan pengguna mock) pada item exported, dan usulan return pada item succeeded bila ada; resolve/return mock menolak 409 *_EVIDENCE_MISMATCH bila langkah 2 key beda.
H2 UI (`components/status-dialogs.tsx`, `components/status-items.tsx`, `components/status-tab.tsx`, `errors.ts`, i18n review): bila item punya usulan:
- Dialog hasil/return menampilkan panel "Usulan orang pertama": hasil (Gagal/Tidak terkirim atau Dana kembali), tombol/tautan "Lihat bukti" (buka url di tab baru, rel noopener), pengusul (nama bila ada lookup user di fitur ini; pengguna sendiri = "Anda"), waktu (format tanggal-jam fitur), catatan.
- Penyetuju kedua: hasil dikunci ke usulan, TIDAK ada unggah berkas, kirim evidenceKey usulan + catatan sendiri. Pengusul sendiri: tombol simpan nonaktif + teks menunggu orang kedua.
- Baris status: penanda kecil "Menunggu orang kedua" bila ada usulan (pakai komponen badge yang sudah ada).
- Map `PAYOUT_RESOLVE_EVIDENCE_MISMATCH` & `PAYOUT_RETURN_EVIDENCE_MISMATCH` ke pesan jelas (kunci baru `error.resolveEvidenceMismatch`: "Bukti berbeda dari usulan orang pertama. Muat ulang lalu periksa usulan; tidak ada hasil yang dicatat.").
- Kunci teks baru di `ws10-payroll-payout-review.ts` bagian `result.proposal.*`.
T2 test-writer (`e2e/payout.mock.spec.ts`): skenario resolve-proposal: panel usulan tampil (hasil, pengusul, tombol Lihat bukti), tidak ada input file, simpan -> pesan resolved; teks "Menunggu orang kedua" di baris.
