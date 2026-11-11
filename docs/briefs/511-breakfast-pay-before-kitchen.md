# 511 Sarapan tiket wajib lunas sebelum dapur (legend-oa0qk P1, uang, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. AGENTS.md proyek berlaku.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin ws/ui-mixed-q36 && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/breakfast-pay -b ws/breakfast-pay origin/ws/ui-mixed-q36`. PORT dan nama DB sendiri. Migrasi sementara hanya 0321-0322.

Konteks: UI ijv8 (commit 47304aa5, cabang ws/ui-mixed-q36) sudah lolos gerbang UI founder; endpoint dan tipe sarapan baru ada di web (mock). Keputusan founder Q43: sarapan dari tiket WAJIB lunas sebelum dikirim ke dapur.
Tugas:
1. Kontrak shared (packages/shared) untuk tipe dan endpoint sarapan yang dipakai web ijv8; web pindah ke tipe shared.
2. Endpoint API pesan sarapan + langkah bayar; API menolak kirim ke dapur/KDS bila belum paid (status kode jelas). Idempotency untuk bayar dan kirim.
3. Tidak ada jalur lain (retry, edge sync, captain, resend) yang bisa memasukkan pesanan sarapan belum lunas ke KDS.
Bukti wajib (jangan sampai rugi): test gagal-dulu bahwa pesanan belum bayar tidak pernah muncul di KDS, pembayaran ganda tidak menagih dua kali, batal setelah bayar tidak memberi refund lebih dari yang dibayar. Test konkurensi dua koneksi untuk bayar+kirim bersamaan.
Paralel: Explore per area (web ijv8, KDS, pembayaran), test-writer, satu implementer per bagian, lalu subagent architect effort xhigh atas seluruh diff. Temuan nyata dibetulkan.
Gate: tsc paket disentuh, eslint/prettier, test terarah lewat `heavy`, db:generate kosong. Commit per langkah, push ws/breakfast-pay (tanpa --force). bd: oa0qk in_progress lalu review.
Laporan: commit, migrasi, bukti test uang, temuan architect, angka subagent (total, puncak, pemegang heavy), yang belum terbukti.
