# 521 Fix temuan Codex 520 gerbang katalog edge (tingkat K)

Untuk thread G48kv (worktree .worktrees/edge-catalog-fresh, cabang ws/edge-catalog-fresh 46cba3ea). Keputusan CTO: betulkan semua sesuai usulan Codex.
1. P1 trusted-clock.ts:61: reanchor waktu dan monotonic saat wall clock menaikkan high-water (jam maju 48j, override 4j, jam dikembalikan: override harus habis setelah 4j nyata).
2. P1 trusted-clock.ts:46: boot offline setelah mati lama dengan jam disamakan ke high-water. Ikuti jawaban founder Q62 (lihat docs/PROGRESS.md / catatan CTO).
3. P1 edge.routes.ts:189: MFA segar, umur MFA, dan expiry sesi pakai dasar waktu tepercaya yang sama, bukan Date.now().
4. P1 catalog-gate.ts:224: generation token/serialisasi supaya reload lama tidak menimpa override terbaru.
5. P2 catalog-gate.ts:263: episode override hanya ditutup setelah katalog pulih DAN jam tidak regressed.
6. P2 catalog-freshness.ts:299: catat sukses sinkron dan checkpoint dengan trusted clock.
Bukti: test gagal-dulu per butir (skenario Codex persis), test terarah lewat heavy, tsc, eslint/prettier, db:generate kosong. Subagent architect effort xhigh atas delta. Commit, push (tanpa --force). Satu laporan akhir.
