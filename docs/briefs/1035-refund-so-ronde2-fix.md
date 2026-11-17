# 1035 Perbaikan SO refund ronde 2 (legend-04izi, yn1of, uvjqq, 8cm5k, 2hl7y)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Opus 5.5 effort high (desain baru di uang: namespace ID refund; Sonnet sudah 2 ronde meloloskan P1). Tingkat K (uang): architect effort xhigh sekali di akhir, dengan checklist interleaving di ~/.agents/team/roles/architect.md.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per temuan, test-writer gagal-dulu per temuan, implementer per kelompok file yang tidak bertumpuk).
Cabang: worktree dari `origin/ghostex/1033-kredit-dp-pool-net-bersama` (6075e2bb6, sudah memuat 1025 018ab5cab). Kerjakan di cabang ini; 1025 + 1033 landing sebagai satu cabang ini.
Sumber: docs/qa/second-opinion-refund-ronde2-1034.md (skenario lengkap) dan ronde 1 docs/qa/second-opinion-refund-area-1032.md.
- 04izi (P1): refund kita pending dengan provider_ref belum bukti sukses. Jangan kembalikan `own` tanpa fact/stamp/hold; perlakukan sebagai in-flight (hold atau tunggu jawaban final), dana parkir tidak boleh bisa dibayar ulang.
- yn1of + uvjqq (P1): namespace ID refund sintetis vs asli. Bedakan asal fact dengan kolom/penanda eksplisit (mis. `source` = provider|synthetic_full), bukan prefix string; ID sintetis tidak boleh bisa bertabrakan dengan ID provider atau ID pembayaran apa pun. Migrasi boleh (nomor kerja 0656-0657), backfill baris lama dengan aman.
- 8cm5k (P2): validasi sumber/jurnal harus memakai daftar kredit yang sama dengan yang dipakai (satu pembacaan di bawah lock, atau kunci reservation-credit juga di finalisasi yang membuat remainder).
- 2hl7y (P2): guard jurnal refund split membandingkan total kumulatif refund kelompok evidence dengan dana parkir, bukan per row.
Test wajib (gagal-dulu): skenario tiap temuan persis; event ganda/berbalapan; tenant lain; tamu tidak dibayar lebih, outlet tidak rugi, jurnal = uang nyata. 17 berkas test terarah 1033 tetap hijau.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API lewat heavy (sekali per perbaikan), db:generate kosong setelah migrasi. Commit, push tanpa force.
Laporan sekali di akhir (Monitor, bukan sleep loop): perilaku per temuan, test, temuan architect, SHA, migrasi, angka subagent (total, puncak, pemegang heavy).
