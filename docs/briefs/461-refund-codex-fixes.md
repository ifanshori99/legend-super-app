# Brief: perbaikan temuan second-opinion refund (legend-hhm5m)

Di cabang lanjutan rat9r yang sedang kamu kerjakan (gabungan rat9r 391a5514 + ti19m 79923008). Keputusan CTO: semua nyata, uang -> architect xhigh. Aturan founder Q25: voucher + refund per item <= yang dibayar tamu; ragu = batasi.

1. P1 `order-recovery-paid-value.ts:428-489`: tukar berantai (100rb -> 200rb belum dibayar tambahannya -> 50rb) terbit voucher 150rb. Simpan nilai dibayar item asal di setiap tukar; tambahan dihitung hanya setelah benar-benar dibayar.
2. P1 `order-recovery.service.ts:1217,1315-1319`: nilai dibayar hanya disimpan untuk tukar lebih murah; item promo dibayar 20rb, tukar harga sama, pengganti gagal -> voucher sistem 100rb. Simpan batas di semua tukar; voucher sistem dibatasi nilai dibayar.
3. P1 `order-recovery-refund.ts:589-638`: open bill promo, reservasi refund lain menyerap pembayaran, refund A Rp0 tapi bagian A tidak dicatat di ledger; bila reservasi lain gagal, refund B bisa 180rb. Tahan/catat alokasi A sebelum recompute ditandai selesai.
4. P1 `order-recovery-refund.ts:932-940` (ti19m): refile A (approval_expired) -> B; urutan berbasis jam/seri bisa membuka refund yang ditolak. Urutkan percobaan dengan relasi refile atau nomor monoton di bawah lock. Terapkan juga ke helper yang dipindah ke `order-recovery-paid-value.ts:586-600`.
5. P2 `order-recovery-paid-value.ts:137-148`, `order-recovery-refund.ts:556-564`: replay memakai ulang slot pembulatan pajak; jurnal membalik PBJT Rp3 dari asal Rp2. Alokasi komponen stabil / lacak sisa per komponen.

Test gagal-dulu per butir (skenario angka di atas), eslint+prettier file berubah, typecheck api/web heap 6144, commit+push tiap langkah. Lapor bersama eajpb/5g9sn/pqm3t.
