# Brief 89c: rantai merge-prep dibangun ulang tanpa DOIT dan pos-shift

Konteks (brief 89): DOIT ditahan (temuan Codex P1, brief 95) dan pos-shift ditahan (2 test ULID gagal di cabang asal). Rantai prep lama (procurement 72602a8d, kds 91fc9be7, receipt 27d6c41c) berisi doit + pos-shift, jadi tidak dipakai. Rantai baru di atas m1 `4a040820` (= prep/payroll-pph21-tests, migration terakhir 0085):

1. inventory-gl: `.worktrees/prep-inventory-gl`, cabang `prep/inventory-gl` (dari ws/inventory-gl bf5c895f). Base 4a040820. Migration cabang lama 0075/0076 → regen 0086+.
2. deploy-prep: `.worktrees/prep-deploy-prep`, cabang `prep/deploy-prep`. Tanpa migration. Base = head prep/inventory-gl.
3. procurement: `.worktrees/prep-procurement`, cabang BARU `prep2/procurement` (dari ab00e3dd). Base = head rantai sebelumnya.
4. kds: `.worktrees/prep-kds`, cabang BARU `prep2/kds` (dari ddb1973e). Base = head rantai sebelumnya.
5. pos-shift, struk, doit: menyusul setelah fix.

Tahap A (merge base m1 4a040820, tanpa regen) boleh paralel per cabang: ikuti 89a dengan base `4a040820`, pesan `merge-prep: m1 4a040820 into <cabang>`.
Tahap B (serial, urutan di atas): merge head rantai sebelumnya (`merge-prep: chain <sha> into <cabang>`; drizzle/meta ambil sisi base), lalu regen per 89b. Nomor migration berikut setelah entri terakhir journal base.
Referensi worktree lama prep-procurement/prep-kds dari rantai doit tetap ada di cabang `prep/procurement` 72602a8d dan `prep/kds` 91fc9be7: hasil penggabungan konflik kode dan pembungkus NO FORCE di sana boleh dicontoh (`git show prep/kds:<path>`).

## Tambahan (09-11)
- refund-approval fix Codex (brief 92): `.worktrees/prep-refund-approval`, cabang BARU `prep2/refund-approval` (dari ws/refund-approval 7c24b7b8). Refund lama sudah di m1 (0079); cabang ini membawa migration baru `0069_refund_fund_evidence_unique` → regen. Tahap A: merge 4a040820 (base bersama 09385266, konflik diperkirakan kecil).
- doit-provider fix Codex (brief 95): `.worktrees/prep-doit-provider`, cabang BARU `prep2/doit-provider` dari 416c94b9 (prep lama: ws 8fed84ef + m1 journals). Tahap A: merge `ws/doit-provider` (96df32a8) dulu, lalu merge 4a040820. Rujukan penyelesaian konflik m1 lama: commit 6965d98b.
- Urutan regen tahap B: inventory-gl → refund-approval → deploy-prep (tanpa regen) → procurement → kds → doit → pos-shift → struk.
- e2e-az (WS-13, hanya test): `.worktrees/prep-e2e-az`, cabang `prep/e2e-az` (dari ws/e2e-az 3bf9e8d1). Tanpa migration. Tahap A: merge 4a040820. Masuk rantai setelah deploy-prep. Skip `describeUntilMerged("ws/<cabang>")` (apps/api/src/test/e2e-az/pending-branch.ts) diganti `describe` di m1 setelah cabang itu digabung, lalu e2e-az dijalankan.
- Nanti: ws/fix-sharp (legend-vj37, prioritas: build produksi crash), ws/fix-whitelabel (ozud, ww29).
- ws11-reports (WS-11 laporan): `.worktrees/prep-ws11-reports`, cabang `prep/ws11-reports` (dari ws/ws11-reports 53e6b484). Tanpa migration. Tahap A: merge 4a040820. Masuk rantai setelah e2e-az. Gate gagal (bukan konflik merge) → reopen G2lso.
- pos-shift siap (ws 69ddb9a4, legend-xvyr): `prep/pos-shift` 2ae64750 = m1 4a040820 + pos-shift (0086-0088, tanpa regen ulang) + fix ULID + fix nama migration pos-day. Bila gate-nya hijau sebelum inventory-gl digabung: pos-shift digabung dulu (jalur kritis struk dan e2e-az), inventory-gl diregen ulang ke 0089+.
- fix-whitelabel (legend-ozud, legend-ww29): `.worktrees/prep-fix-whitelabel`, cabang `prep/fix-whitelabel` (dari ws/fix-whitelabel 47bcf9c1). Web saja, tanpa migration. Tahap A: merge head m1 terbaru.
- fix-sharp (legend-vj37, prioritas tinggi: build produksi crash): SHA menyusul.
- `pnpm check` tidak menjalankan `format:check`: jalankan `pnpm -s format:check` di prep sebelum tiap merge ke m1 (m1 b49202b5 sudah dibetulkan untuk 2 file refund).
- ws02-edge (G0c95): `.worktrees/prep-ws02-edge`, cabang `prep/ws02-edge` (dari ws/ws02-edge 756b45ae). Migration cabang 0079/0080 → regen. PENTING: FK `edge_sync_conflict_resolutions` wajib tetap di dalam CREATE TABLE (jangan dipisah jadi ALTER TABLE ADD CONSTRAINT oleh drizzle-kit; bila generate memisahkannya, susun SQL agar FK inline seperti SQL lama). Custom 0080 = salinan apa adanya `apps/api/src/db/schema/edge-sync-conflict.custom.sql`. Tahap A: merge head m1 terbaru. Gate gagal (bukan konflik merge) → reopen G0c95.
- fix-auth06 (AUTH-06, bcad09cf, web saja): `prep/fix-auth06` dirantai di atas refund f5025cf9 (e75ea4b2 + merge). Masuk m1 setelah refund. Gate: `pnpm check` + format:check; e2e auth/roles sudah hijau di cabang (CTO).
- Urutan rantai kini: refund f5025cf9 → fix-auth06 → procurement → kds → doit → ws02-edge → e2e-az → ws11-reports → fix-whitelabel → struk.
- pos-receipt (struk): `.worktrees/prep-pos-receipt`, cabang BARU `prep2/pos-receipt` (dari ws/pos-receipt 1657797e). Tahap A: merge m1 13425b65 (sudah berisi pos-shift + doit). Rujukan penyelesaian konflik: commit 87b21e8d (merge lama di atas f98c95f7) dan fix 85723463 (G1vpr: tes struk ikut aturan shift, `pos-order.routes.ts` memakai `deviceIdOf` m1, BUKAN `verifiedDeviceId` lokal). Terapkan isi 85723463 (cherry-pick; abaikan bagian drizzle bila ada). Migration cabang 0068/0069 lama → regen di tahap B setelah fix-whitelabel.

## e2e-az (antrean, 09-11)

- prep/e2e-az 263ce1ec (di atas f7497336, basis chain fef266fe ws02-edge). Hasil G4k8i: 7 file, 83 lulus, 38 skip, 0 gagal.
- Skip EDC-01/02/04 menunggu legend-dahk/m4fv (G106p, brief 102). Jangan unskip di merge train.
- Urutan: setelah ws02-edge, ws11-reports, fix-whitelabel, pos-receipt. Merge chain head terakhir, unskip skenario pos-receipt (az-e:1301, az-r:338/342), jalankan e2e-az + gate penuh, lalu merge ke m1.

## Rantai 3 (09-11, tanpa head-of-line blocking)

- CTO: jangan biarkan satu cabang menahan antrean.
- prep3/ws11-reports ae5ed5c1 = stage A 4d6b48a7 + m1 13425b65 + cherry-pick prettier 332a09dd dan fix lint 7f1bc9c5 (G8kmx).
- prep/ws02-edge 5f768fb7 = fix training 9f1c40af (G0h5c) + chain prep3/ws11-reports. Migrasi tetap 0099/0100.
- prep3/fix-whitelabel 0c977a95 = 36647d4a + chain prep3/ws11-reports. Saat giliran: merge chain head ws02.
- pos-receipt: prep2/pos-receipt 883858e5 (regen 0101/0102 di atas ws02 fef266fe) tetap berlaku. Saat giliran: merge chain head.
- m1 1e2ab930: cherry-pick PRD d6a223d9 (docs/PRD.md saja). Cek tree identity setelah merge: selisih yang boleh hanya docs/PRD.md.
- e2e-az sekarang c01e9c63 (docs QA di atas 263ce1ec).
- Urutan: ws11, ws02, whitelabel, receipt, e2e-az.
- ws-09-ws 1e94f33f (WS-09 fasilitas + Wi-Fi, tingkat K; gate lulus di cabang; second-opinion brief 105 paralel, tidak menahan). Antre setelah e2e-az. Stage A + regen migrasi saat giliran.
- 09-11 antrean CTO (setelah ws09-wifi, lompati yang tertahan): (1) ws/ai-tool-catalog d15542a8 (kontrak katalog AI, wajib dulu), (2) ws/ws12-ai 9f6d680e (basis katalog + m1 4a040820). Migrasi 0086-0091 diregen saat merge. Handoff: docs/PROGRESS.md bagian 'Handoff merge train WS-12' di cabang ws12-ai. Gate penuh belum pernah lulus di HEAD itu (tes terarah 817/817).
- 09-11 antrean CTO: ws/ws03-menu d06b163c (basis m1; migrasi 0086_spicy_rogue/0087_colorful_blue_marvel diregen saat merge). Gate penuh terakhir fc692f1d 1 gagal, dibetulkan a8537a25; d06b163c terarah 28/28.
- 09-11 antrean CTO: ws/ws08-site 0800ac71 (sudah merge m1 a2dfc4ea; migrasi 0099-0105 renumber). Kontrak: orderVoidedPayloadSchema.approvedBy nullable (packages/shared/src/pos/events.ts); typecheck penuh harus lulus di konsumen POS/cloud-sync. delivery_store_index tetap di pengecualian TEN-02 (disetujui CTO).
- 09-11 antrean CTO (basis m1, lompati yang tertahan): fix-codex-procurement 598a39e9 (0099 regen), fix-codex-kds 673ebc36 (tanpa migrasi), fix-codex-shift 92449b85 (0099 regen, setelah procurement), checklist-schedule 286d1993 (0101 regen). Tanpa migrasi digate paralel; regen migrasi serial: receipt, wifi, ws12-ai, ws03-menu, ws08, procurement, shift, checklist.
- 09-11 antrean CTO: ws/ws09-wifi-hardening d2710c47 (basis ws/ws09-wifi b9d7e40b; merge sesudah wifi; migrasi 0101/0102 regen setelah 0104 wifi).
- 09-11 antrean CTO (prioritas): fix-doit-webhook 63a544f8 (P1 uang, tanpa migrasi; prep f336a85c di atas m1 726515a4), fix-edc-codex 164fa725 (P1 penahan rilis; migrasi tulis tangan 0099/0100 -> 0103/0104 di atas m1, brief 89f; setelah masuk buka skip EDC-01/02/04 di e2e-az), fix-journals-expiry dfae77ae (tanpa migrasi; prep f4b06b99).
- Akibat EDC duluan: wifi (0103/0104) dan wifi-hardening (0105/0106, prep 3d87bf54) diregen lagi setelah EDC menjadi 0105-0108.
