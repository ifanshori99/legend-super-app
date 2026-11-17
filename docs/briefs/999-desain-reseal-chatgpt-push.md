# 999 Desain: reseal kunci untuk token ChatGPT dan push_subscriptions

Peran: architect (baca ~/.agents/team/roles/architect.md). Opus 5.5, effort xhigh (akses/kunci). Read-only: tulis dokumen desain, jangan ubah kode produk.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per area: sealed-secret/reseal job, ai_chatgpt_connections + refresh, push_subscriptions).

Kartu: legend-rj284 (sisa legend-h1da5 dari 995, cabang ghostex/995-refund-voucher-hardening-kecil 892f58a11).
Masalah: job reseal (rotasi kunci) belum mencakup (1) token ChatGPT di `ai_chatgpt_connections`, yang harus ikut protokol lease/CAS refresh token supaya reseal tidak balapan dengan refresh, dan (2) `push_subscriptions`, yang butuh `key_version` + AAD per user, sedangkan `SealedSecretColumn` belum mendukung AAD per user.

Hasil: `docs/design/reseal-chatgpt-push.md` berisi pilihan (maks 3), rekomendasi, migrasi yang dibutuhkan, urutan rilis, test balapan wajib (reseal vs refresh bersamaan, reseal ulang idempoten, token lama tidak bisa dibuka setelah rotasi selesai), dan pecahan kartu engineer (3-6 kartu, area file terpisah). Base baca: origin/milestone/m1 + cabang 995.

Laporan: ringkasan rekomendasi, kartu yang diusulkan, risiko, angka subagent. Commit dokumen desain saja di cabang worktree-mu, push tanpa force. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
