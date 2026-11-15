# 866 Selidiki flake: PC-22 kas kecil (uang) dan publisher master-data (engineer Codex)

Cabang fix/flake-866 dari milestone/m1 (46f9d1bca). Codex tidak menjalankan bd; detail kartu di bawah.
- legend-5tu68: accounting-petty-cash.test.ts PC-22 gagal sekali di run penuh batch65 (balance_after 100000 vs 60000), lulus 3/3 terarah. Ini test uang: buktikan dulu apakah ini bug produk (urutan/balapan saldo, query tanpa ORDER BY, waktu sama, isolasi transaksi) atau murni test (fixture/urutan/data bersama). Bug produk: perbaiki dengan test gagal-dulu yang deterministik (mis. paksa urutan/waktu sama) dan lapor ke CTO sebelum merge. Murni test: perbaiki tanpa melonggarkan asersi saldo.
- legend-8p74m: edge-master-data-publisher.test.ts "worker discovers a committed master change" timeout 34-45 s di bawah beban. Cari akar (polling interval, tunggu tanpa batas, kompetisi worker); jangan sekadar menaikkan timeout.
Bukti: jalankan file terkait berulang (minimal 10x lewat heavy, LEGEND_TEST_FILES) setelah perbaikan; laporkan angka sebelum/sesudah. Pra-gate AGENTS.md. Commit + push tanpa force. Lapor sha dan akar masalah tiap kartu.

```
○ legend-5tu68 [BUG] · Flake: accounting-petty-cash PC-22 expectLedgerConsistent balance_after 100000 vs 60000 (satu kali di run penuh)   [P3 · OPEN]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-15 · Updated: 2026-11-15

DESCRIPTION

  batch65 15 Nov, run penuh 07:00-08:21: legend-4961-PC-22 gagal sekali       
  (expected 100000 to be 60000, accounting-petty-cash.test.ts:336), lulus 3x  
  berturut-turut terarah. Batch65 tidak menyentuh kas kecil. Kandidat urutan  
  entri (balance_after terakhir) saat beban tinggi; periksa urutan entries    
  tanpa tie-break.                                                            



```
```
○ legend-8p74m [BUG] · Flake: edge-master-data-publisher 'worker discovers a committed master change' timeout under load   [P3 · OPEN]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-15 · Updated: 2026-11-15

DESCRIPTION

  batch65 15 Nov: gagal sekali (waitFor 34s, edge-master-data-                
  publisher.test.ts:285) saat typecheck + 188 berkas tes jalan bersamaan;     
  lulus 3x berturut-turut terarah. Kandidat flake berbasis waktu/beban.       



```
