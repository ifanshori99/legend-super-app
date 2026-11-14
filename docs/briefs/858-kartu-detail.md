# detail kartu (bd show)

```
◐ legend-y4f3l [BUG] · E2E mock POS koreksi merah di milestone/m1: legend-mzg, legend-rx0h, legend-sgg (6 test)   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-13 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Ditemukan merge train batch61 14 Nov: 6 test gagal sama di base milestone/m1
  (bukan regresi batch61). nv3y dan ogx3 lulus. Cari akar (pesan 409          
  EDGE_ORDER_CORRECTION_BLOCKED? selector?) dan betulkan.                     



NOTES

  Codex G7kzr brief 858                                                       



LABELS: e2e, qa


```

```
◐ legend-0y8tf [BUG] · E2E expo/pickup gagal di m1: mock memuat 'Sesi akses dukungan · Hanya baca' sehingga 'Panggil nomor' tidak bisa diklik   [P2 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  legend-zvz (3 test) dan legend-ujxl Q26 (2 test) gagal sama persis di basis 
  m1 (ditemukan thread 780, 14 Nov). Kemungkinan fixture mock support-access  
  bocor ke sesi staf.                                                         



NOTES

  Codex G7kzr brief 858                                                       



COMMENTS
  2026-11-14 14:11 Ilham fadillah Anshori
    
      Selesai di fix/e2e-mock-support-access c3cef7cb4: akar ekspektasi spec lama 
      (A-012..A-014, label 'Kopi 1'), bukan banner. 13/13 e2e lulus. Catatan      
      merge: ghostex/780-ui-operasional-kecil juga mengubah e2e/legend-           
      ujxl.mock.spec.ts (Kopi 1).                                                 

```

```
◐ legend-42v4v [BUG] · e2e legend-e8oa.mock.spec.ts:254,263 (delivery) gagal di kode dasar m1   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Ditemukan 844; gagal identik di base.                                       



NOTES

  Codex G7kzr brief 858                                                       



LABELS: delivery, test

```
