# Jurnal manual: "Ajukan untuk persetujuan" (legend-ktpc0, mockup 5ac3)

Tombol di form jurnal manual memakai endpoint yang sudah ada di kontrak bersama, tanpa `CONTRACT_PENDING`: `createManualJournal` atau `updateManualJournal`, lalu `submitManualJournal` (`saveAndSubmitManualJournal` di `api.ts`). Persetujuan tetap oleh orang lain (AUTH-06) di layar detail.

## Yang belum ada

- Simpan dan ajukan dalam satu panggilan atomik. Klien memanggil dua endpoint berurutan. Bila langkah kirim gagal, draf tetap tersimpan; form membuka detail draf dan pengguna mengirim ulang dari sana (`SubmitAfterSaveError`). Satu endpoint simpan-dan-ajukan menghapus kondisi setengah jalan itu.
- Jurnal per outlet di kepala jurnal. Form mengirim `outletId: null`; outlet dicatat per baris (ACC-03), sesuai mockup 5ac3.
