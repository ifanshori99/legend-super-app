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
