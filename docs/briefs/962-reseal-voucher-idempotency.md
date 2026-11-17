# 962 Rotasi kunci: snapshot JSON idempotensi voucher (K akses/PII)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (akses).
Cabang: worktree-mu dari `origin/ghostex/ws-01-pengerasan-akses-951` (b4f260a98). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0490-0494 (nomor kerja) bila perlu.
Kartu legend-ra1k0 (SO 957 P2-1, `git show ux/customer-order-benchmark:docs/qa/second-opinion-akses-946-951.md`): `promo_command_idempotency.response` (AAD `promo-voucher-idem:<tenant>:<key>` dan `apology-voucher-idem:<tenant>:<key>`) ikut sweep reseal job; sisa JSON terhitung di laporan remaining dan syarat pensiun kunci. Sweep resumable, filter tenant, lock/CAS yang mempertahankan fingerprint dan isi respons lain.
Jangan sampai rugi: replay setelah rotasi mengembalikan kode voucher yang sama, tanpa voucher kedua dan tanpa catatan keuangan kedua; isolasi tenant.
Paralel: Explore + test-writer (gagal-dulu dari usul test SO) dalam satu giliran; implementer; lalu test-runner + architect xhigh bersamaan. Suite besar hanya setelah kode beku.
Bukti: gagal-dulu lalu hijau; test area reseal/crm-promo/apology-voucher lewat heavy setelah commit terakhir; pra-gate AGENTS.md; typecheck API sekali; architect tanpa P1.
Laporan: SHA, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kartu. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
