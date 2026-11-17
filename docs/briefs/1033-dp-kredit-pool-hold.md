# 1033 Kredit DP: pool net bersama + blok saat hold terbuka (legend-6n4p3, legend-obgj5)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): architect effort xhigh sekali di akhir.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore reservation-deposit-credit/remainder + refund_recon_holds, test-writer gagal-dulu per temuan, implementer).
Cabang: worktree dari `origin/ghostex/3d4eb7b8` (1028, 9f079e2aa). Langkah awal: `git merge --no-ff origin/ghostex/1025-refund-provider-celah-uang` (1028 antre sesudah 1025; butuh tabel refund_recon_holds). Jangan rebase.
Sumber: docs/qa/second-opinion-refund-area-1032.md temuan 2 dan 3 (skenario lengkap di sana).
- legend-6n4p3 (temuan 2): kredit DP asli dari satu intent yang dialokasikan ke beberapa sesi harus berbagi satu pool net (DP intent - refund provider - kredit sudah terpakai sesi lain), dikunci di lock deposit-intent yang sama. Total pemakaian semua sesi <= net. Contoh: DP 100, alokasi 50/50, provider refund 40 -> total kredit <= 60.
- legend-obgj5 (temuan 3): selama ada refund_recon_hold terbuka pada intent sumber, kredit DP dan pembuatan remainder dari nominal sebelum hold diblokir (atau dibatasi ke net dikurangi jumlah hold, pilih yang membatasi). Hold dibuat setelah kredit terpakai: tetap jalur credit_used_before_provider_refund dari 1025c.
Jangan sentuh: payment-provider-partial-refund.ts dan payment-webhook.service.ts (dikerjakan thread 1025c untuk temuan 1 dan 4).
Test wajib (gagal-dulu): skenario temuan 2 dan 3 persis; dua sesi bersamaan; resolve hold lalu kredit lanjut sesuai net; tenant lain; tamu tidak dibayar lebih, outlet tidak rugi. Berkas test 1028 dan 1025-d tetap hijau.
Migrasi hanya bila perlu, nomor kerja 0654-0655. Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API lewat heavy (sekali per perbaikan), db:generate kosong. Commit, push tanpa force ke cabangmu.
Laporan sekali di akhir (Monitor, bukan sleep loop): perilaku per temuan, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
