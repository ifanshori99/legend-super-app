# 1108 Perbaikan refund ronde 11 (tingkat K uang)
Lanjutan 1103, cabang `ws/1072-refund-ronde6-q45` (head e1e1d99ab), worktree `legend-2ad4d9ab`. Laporan SO: `docs/qa/second-opinion-refund-ronde11-1107.md` (2 P1 + 1 P2). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran. Push tanpa `--force`. Tanpa migrasi (0697 bebas bila terpaksa, lapor dulu).

## Keputusan CTO (membatasi; ronde 11, jadi tutup kelasnya, bukan kasusnya)
1. Saklar refund DOIT mati = jalur webhook refund **hold-only** untuk SEMUA jenis cocok (kunci, refund id, settle manual, payment-object, `viaSettled` atau tidak), payload valid maupun invalid, sukses maupun penolakan: satu hold CONFLICT per event tersimpan (kunci stabil), lalu berhenti. Tidak memanggil updater, recorder, tidak membuat fact, jurnal, refund, atau mengubah status R. Satu titik gerbang di awal `processRefundEvent` (bukan pengecualian per cabang). Ini menutup P1-1.
2. P1-2: daftar semua pemanggil recorder (`payment-provider-partial-refund.ts`). Bila saat saklar mati masih ada pemanggil di luar webhook (mis. settle manual finance), perbaiki juga: fact provider X sudah ada + laporan X lebih besar -> naikkan/buka hold (sama dengan F4/F5), jangan lewati di `:928-930` dan `:983-985`. Bila tidak ada pemanggil lain, tetap tambah test bahwa saklar mati + laporan membesar untuk X yang sudah fact = hold, bukan diam.
3. P2: sebelum membuat hold dengan kunci F6 baru, cari hold lama untuk event tersimpan yang sama (kunci `row.id` build lama); bila ada, pakai/naikkan itu, jangan buat hold kedua yang bisa dihitung.
4. Test suite saklar-nyala (`DOIT_REFUNDS_ENABLED=true`) tetap lewat jalur lama; jangan melemahkan assert uang.

## Bukti
Test per temuan merah di e1e1d99ab, hijau di head; test 1101 + 1072/1075/1077/1088 tetap hijau; typecheck API (antre heavy; boleh diterima dari merge train `pnpm check` bila antre > 60 menit, tulis itu di laporan); prettier/eslint. Subagent architect xhigh review diff akhir sekali.

## Laporan
Per temuan, commit, head SHA (push), risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali (Monitor sampai job selesai).
