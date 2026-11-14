# 856 Kas laci, hitung ulang, dan refund (engineer Sonnet, uang)

Cabang fix/kas-laci-856 dari ws/cash-out-approval (049d5e65c, kerja 841). Langkah 0: `git log --all --oneline --grep=<id>` per kartu; sudah ada: lapor, jangan ulang.

Kartu:
- legend-t78la: refund/void ditahan memakai kas fisik laci (expected dikurangi kas refund/void tertahan) di cashOutExceedsDrawer (pos-cash-guard.ts).
- legend-9me96: hitung ulang karena keputusan supervisor atas kas keluar tertahan tidak mengurangi jatah hitung ulang kasir.
- legend-56mo2: POS memberi tahu kasir saat QRIS direfund karena penjualan EDC masih terbuka (edc_request_open).
- legend-wghbj: approver tak berwenang yang mencoba setujui refund dana tak teralokasi tidak boleh membuat refund failed (harus 403, status tetap).

Jangan sampai rugi: tiap kartu punya test bahwa tidak ada uang keluar melebihi kas fisik atau sisa bayar, dan outlet tidak rugi. Ragu: pilih yang membatasi pembayaran dan tanya CTO.
Tanpa migrasi (bila perlu: lapor dulu, rentang 0445-0447).
Paralel: test-writer, satu implementer per kartu (file terpisah).
Review: satu subagent architect effort xhigh (uang).
Pra-gate AGENTS.md. Commit + push tanpa force. Klaim kartu dengan bd, jangan close. Lapor sha, test, temuan review, angka subagent.
