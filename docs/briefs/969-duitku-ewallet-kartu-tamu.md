# 969 Duitku e-wallet + kartu untuk tamu (BE)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/940-qr-va-sisa-p3` (fbd0235e7; 940 + 9vmit, belum di m1). Langkah pertama `heavy pnpm worktree:setup` (antrean heavy padat: selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi bila perlu: 0510-0514 (nomor kerja).

Kartu (`bd show legend-kt3t1`; claim dulu): perluas `GUEST_PAYMENT_METHODS` (shared) dengan e-wallet dan kartu Duitku; `payment-options` membaca `methods()` gateway, bukan daftar tetap; varian instruksi redirect (URL bayar) di DTO; `createIntent` Duitku menerima e-wallet/kartu. Kartu FE legend-6xf7x menunggu ini (cabang `ghostex/duitku-fe-ws05` ditahan Q24/Q25; jangan sentuh `apps/web`).

Aturan uang (founder Q15, 9vmit): satu intent aktif per tagihan; ganti metode = void kode lama dulu (pakai jalur 9vmit, jangan buat jalur kedua); idempotensi per kunci; redirect/kartu tidak boleh melunasi bill dua kali bila callback dan poller datang bersamaan; nominal dari bill di server, bukan dari tamu. Bila ragu: tolak, jangan bayar.
Jangan sampai rugi: test bukti (1) tidak ada bayar ganda saat ganti dari VA/QRIS ke e-wallet/kartu dan sebaliknya, (2) callback e-wallet telat ke intent lama diparkir, tidak melunasi, (3) nominal tidak bisa diubah tamu, (4) tamu tidak bisa membuat intent untuk bill tenant/outlet lain, (5) metode yang tidak aktif di gateway tenant ditolak.

Jangan sentuh: refund/rekonsiliasi (967, cabang `ghostex/60a93dca`), `services/ai-*` (964), langganan DOIT (965).

Paralel: Explore (Duitku adapter + payment-options + guest route) + test-writer gagal-dulu dalam satu giliran; implementer shared+DTO dan implementer adapter/route bila file terpisah. Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API + web (shared berubah), test terarah grup payment/qr-va/ws03-guest/duitku, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
