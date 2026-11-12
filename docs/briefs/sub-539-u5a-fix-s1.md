# Fix S1 (legend-nb4iy) dari review

1. Outlet milik tenant `archived` (server beri restorable=false, platform-org.service.ts:725-726) jangan tampil "final/expired". RestoreSection outlet terima status tenant induk; bila archived tampilkan pesan "Pulihkan tenant dulu" (keadaan parent_archived). Expired hanya bila restorableUntil < sekarang.
2. 409 RESTORE_NOT_AVAILABLE dan INVALID_TRANSITION jangan pakai teks "pemeriksaan keamanan". Klasifikasi baru: not_available (sudah dipulihkan / tidak tersedia), parent_archived (tenant induk masih diarsip). Teks keamanan hanya 401/403. Update i18n + test node.
3. Setelah error 409 (expired/not_available/parent_archived) refetch/invalidate query window di onError. Label tombol "Kembali ke daftar" (restore-section.tsx:328) diganti sesuai perilaku ("Kembali").
4. Beri key={tenant.id} pada TenantDetail/RestoreSection tenant dan key={outlet.id} pada panel outlet (tenant-detail-page.tsx) supaya state tidak bocor antar tenant.
5. A11y: saat review→confirm fokuskan judul/textarea konfirmasi; banner sukses: region live sudah ada sebelum konten masuk.
   5 (cek saja, jangan ubah backend): apakah outlet tenant lain terjangkau dari Panel Platform (`orgEndpoints.listOutlets` dibatasi tenant sesi). Laporkan ya/tidak + bukti.
