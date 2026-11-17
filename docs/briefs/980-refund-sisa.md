# 980 Refund sisa: cek "sudah dibayar" kurangi refund provider, pembulatan refund parsial, refund macet di provider, persetujuan refund manual
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/recon-refund-parsial-provider` (9788dc422; 958 + 967, belum di m1). Langkah pertama `heavy pnpm worktree:setup` (selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi bila perlu: 0540-0544 (nomor kerja).

Kartu (`bd show <id>`; claim dulu; satu implementer per kartu, file terpisah):
- legend-m9pf6: cek "sudah dibayar" di `bill-split.service.ts`, `pos-order-payment.ts`, `pos-qris-hold.ts`, `qr-order-consumers.ts`, `facility-breakfast-consumers.ts` belum mengurangi refund provider (`payment_provider_refunds` 967). Pakai satu helper nilai bersih yang sama dengan 967; penjualan tidak boleh tampil lunas penuh setelah refund parsial provider.
- legend-9z1r5: `allocateIdr` pada refund parsial bisa selisih Rp1. Sisa pembulatan tidak boleh membuat total refund melebihi yang dibayar, per bagian maupun total.
- legend-17ml: tutup refund yang sudah disetujui tapi macet di provider (provider_ref/poll terisi, MANUAL_RECONCILIATION atau PAYOUT_NOT_FOUND_MAYBE_SENT) setelah dibayar manual: alat ber-izin (requirePermission, filter tenant di SQL) dengan bukti bayar manual, satu kali, idempoten, jurnal benar.
- legend-uyw0v: alur persetujuan refund manual untuk masalah order (approvalRequestId/overrideId): refund manual wajib lewat persetujuan, sekali pakai, terikat order dan nominal.

Jangan sampai rugi: test bukti (1) tidak ada refund ganda (provider + kita + manual), (2) total refund tidak pernah melebihi yang dibayar setelah pembulatan, (3) refund macet yang ditutup manual tidak bisa dibayar lagi oleh poller/retry, (4) persetujuan tidak bisa dipakai ulang atau untuk order/tenant lain, (5) penjualan dengan refund parsial provider tidak tampil lunas penuh. Bila ragu: blok.

Jangan sentuh: payroll (dd932307), POS kas/harga (974), `services/ai-*`, DOIT recurring (965), Duitku (969), edge (978).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu. Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API (+web bila shared berubah), test terarah grup payment/refund/qris-hold/payout/bill-split/pos-order/qr-order/facility, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
