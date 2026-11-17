# 1031 qrSaleInUseOfIntent pakai net provider-refund (legend-19j3c)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur qrSaleInUseOfIntent + net provider-refund dari 980, test-writer gagal-dulu, implementer).
Base: origin/milestone/m1 f92a5c904 (batch85 sudah memuat 980). Temuan merge train batch85: `apps/api/src/services/payment-admin.service.ts:274` qrSaleInUseOfIntent memakai jumlah gross, bukan net sesudah provider-refund (980). Efek sekarang membatasi: refund QR split bisa terblokir padahal sisa dana cukup.
Target: batas refund QR split = net dana tersisa (gross - provider refund selesai - refund in-flight). Jangan pernah lebih dari dana nyata yang tersisa.
Jangan sentuh: berkas resolve-hold milik thread 1025 (refund_recon_holds) kecuali baca.
Test wajib (gagal-dulu di base): refund QR split setelah provider-refund sebagian lolos sampai sisa net, tolak di atasnya; refund ganda/bersamaan tidak melebihi sisa; refund in-flight dihitung; tenant/outlet lain; outlet tidak rugi, tamu tidak dibayar lebih.
Migrasi: tidak diharapkan; bila perlu, nomor kerja 0649.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API lewat heavy (satu kali), db:generate kosong. Commit, push tanpa force.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
