# 862 Second opinion: kas laci, tutup shift, refund (Codex read-only, xhigh uang)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only, jangan edit kode.
Area (gabungan, diff terhadap milestone/m1):
- ws/cash-out-approval (841: persetujuan kas keluar, tutup shift, recordCashMovement)
- ghostex/0c60597d (856: refund/void ditahan kas fisik, jatah hitung ulang, 403 approver)
- ghostex/alarm-ops-refund-struk (850: refile refund otomatis, alarm struk terlambat)
Fokus: jalur uang keluar melebihi kas fisik atau sisa bayar; refund ganda lewat refile/balapan; kasir menyetujui kas keluarnya sendiri; variance tutup shift bisa dimanipulasi lewat hitung ulang; isolasi tenant/outlet.
Tulis temuan ke docs/qa/second-opinion-kas-laci-refund-15nov.md (P0-P3, file:line, skenario konkret, usulan perbaikan), commit di cabang so/kas-laci-862 dari ux/customer-order-benchmark, push tanpa force. Lapor ringkas jumlah temuan per tingkat.
