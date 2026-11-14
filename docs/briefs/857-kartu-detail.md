# 857 detail kartu (bd show)

```
◐ legend-7l2bq [BUG] · planDeduction menggagalkan seluruh order bila satu lokasi stok milik outlet nonaktif (snapshot HPP hanya mengosongkan baris itu)   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Batas terdokumentasi di 837 kartu legend-xtuik (5435be8d8). Penjualan tidak 
  boleh buntu karena satu lokasi nonaktif; samakan perilaku dengan snapshot   
  atau tolak dengan pesan jelas.                                              



NOTES

  Codex G4v70 brief 857                                                       



LABELS: inventory, pos

```

```
◐ legend-mksir [BUG] · Retur supplier gagal ACCOUNT_MAPPING_MISSING bila akun 5106 (selisih harga persediaan) dipetakan ke akun kustom/non-expense/induk   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Dari 837 (f6315f99f, legend-uloj6). Retur dengan selisih tidak nol gagal    
  bila tenant mengganti pemetaan 5106. Butuh validasi pemetaan di pengaturan  
  akun + pesan jelas, atau backfill sebelum rilis.                            



NOTES

  Codex G4v70 brief 857                                                       



LABELS: accounting, inventory

```

```
◐ legend-1get7 · Laporan pengecualian keuangan: intent DP (deposit) belum ikut resolusi receipt-pending   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Temuan architect 853: order tertahan karena struk DP belum masuk            
  (accounting-auto-journal-amounts.ts:1100, accounting-auto-journal-          
  guards.ts:612) menampilkan intentId/outboxState salah di accounting-finance-
  exceptions.service.ts. Sumber intent: reservation.ts:390, reservation-      
  deposit-remainder.ts:29, pos-deposit-refund.ts:31. Laporan baca saja, tanpa 
  perpindahan uang.                                                           



NOTES

  Codex G4v70 brief 857                                                       



```
