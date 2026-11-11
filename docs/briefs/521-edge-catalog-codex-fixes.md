# 521 Fix temuan Codex 520 gerbang katalog edge (tingkat K)

Untuk thread G48kv (worktree .worktrees/edge-catalog-fresh, cabang ws/edge-catalog-fresh 46cba3ea). Keputusan CTO: betulkan semua sesuai usulan Codex.
1. P1 trusted-clock.ts:61: reanchor waktu dan monotonic saat wall clock menaikkan high-water (jam maju 48j, override 4j, jam dikembalikan: override harus habis setelah 4j nyata).
2. P1 trusted-clock.ts:46: boot offline setelah mati lama dengan jam disamakan ke high-water. Jawaban founder Q62 (11 Nov 21:40): BOLEH jualan, tapi tampilkan peringatan di kasir dan kirim alarm ke owner (begitu internet ada, plus antre lokal). Usia katalog tidak bisa dibuktikan = perlakukan sebagai basi untuk promo/voucher (tetap mati, jangan sampai rugi), tetapi blokir jual 24 jam (Q57) TIDAK berlaku di kasus ini. Test: boot offline tanpa bukti waktu -> jual jalan, promo/voucher mati, peringatan + alarm tercatat.
3. P1 edge.routes.ts:189: MFA segar, umur MFA, dan expiry sesi pakai dasar waktu tepercaya yang sama, bukan Date.now().
4. P1 catalog-gate.ts:224: generation token/serialisasi supaya reload lama tidak menimpa override terbaru.
5. P2 catalog-gate.ts:263: episode override hanya ditutup setelah katalog pulih DAN jam tidak regressed.
6. P2 catalog-freshness.ts:299: catat sukses sinkron dan checkpoint dengan trusted clock.
Bukti: test gagal-dulu per butir (skenario Codex persis), test terarah lewat heavy, tsc, eslint/prettier, db:generate kosong. Subagent architect effort xhigh atas delta. Commit, push (tanpa --force). Satu laporan akhir.
