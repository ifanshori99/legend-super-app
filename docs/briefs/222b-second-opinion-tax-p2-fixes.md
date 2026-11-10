# Brief: second-opinion — perbaikan pajak P2 (legend-5yeyq, legend-7gwap, legend-usa4b, tier K)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/tax-p2-fixes`, cabang `ws/tax-p2-fixes`.
Rentang diff: `git diff 94d769c6..ws/tax-p2-fixes` (base = `milestone/m1` 94d769c6). Jangan pakai `merge-base main`. Tidak ada migrasi.
Latar temuan asal: `docs/briefs/170b-second-opinion-pph21-receivable.result.md`, `177b-second-opinion-tax-rule-overlap.result.md`, `173b-second-opinion-provisioning-race.result.md` (folder utama).

## Berkas berisiko
- `packages/shared/src/hris/payroll/pph21.ts` (batas pemotongan W dari cap caller), `packages/shared/src/hris/payroll/payslip-tax.ts` (`payslipWithholdingCap`, `computePayslipTax`)
- `packages/shared/src/tax/overlap.ts` (item probe untuk deteksi tumpang tindih aturan), `apps/api/src/services/tax.service.ts` (publish guard, daftar konflik)
- `apps/api/src/edge/master-sync.ts` (urutan lock import edge: `edge-master-sync`, CoA, lalu lokasi stok; penolakan akun lokal di luar snapshot), `apps/api/src/services/accounting-provisioning.service.ts` (`lockChartOfAccounts`, backfill)

## Invariant
- PPh 21: cap pemotongan = seluruh tunai slip tanpa tunjangan PPh, dikurangi semua BPJS karyawan dan potongan pra-net non-pinjaman (B8). Tunai non-pajak boleh dipakai membayar PPh 21. Piutang PPh 21 hanya muncul bila T melebihi cap itu.
- PPh 21: identitas `withheld + borne + receivable - refunds = T` tetap. Piutang tidak pernah di-gross-up dan tidak menaikkan X/W. Taxable gross, gross-up, titik tetap, dan alokasi default riwayat campuran tidak berubah. Take-home tidak pernah negatif.
- Pajak: aturan aktif yang membuat preview item mana pun gagal `TAX_RULE_AMBIGUOUS` harus ditolak saat publish (409) dan muncul di `GET /api/tax/rules/conflicts`, apa pun isi `appliesTo.itemIds` (UUID tidak harus ada di katalog). Aturan yang tidak tumpang tindih tetap lolos.
- Provisioning: chart of accounts satu legal entity tidak pernah berisi campuran akun dari snapshot cloud/edge dan akun template backfill. Semua penulis CoA/mapping (owner, backfill, import edge) memegang lock CoA yang sama sebelum precheck dan write.
- Import edge: snapshot cloud adalah seluruh chart entitas dan cloud tidak pernah menghapus akun. Akun lokal entitas yang tidak ada di snapshot (misal template hasil backfill di DB edge) membuat apply gagal `LOCAL_CONFLICT` sebelum ada yang ditulis; node sehat tidak boleh terblokir oleh aturan ini.
- Lock: urutan pengambilan lock konsisten di semua jalur (tidak ada dua jalur yang mengambil `edge-master-sync` dan CoA dalam urutan terbalik), sehingga tidak ada deadlock. Lock tetap per tenant/entity; tidak ada akses lintas tenant (TEN-01/TEN-02).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
