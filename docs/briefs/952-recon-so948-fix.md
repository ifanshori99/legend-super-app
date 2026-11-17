# 952 Perbaikan temuan second opinion recon 941 (K uang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang + migrasi).
Cabang: worktree-mu dari `origin/ghostex/rekonsiliasi-sisa-bank-dan-doit` (44dc04cd9). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi 0432-0434 cabang ini belum masuk m1: boleh diedit; migrasi baru 0435-0439.
Laporan SO: `git show ux/customer-order-benchmark:docs/qa/second-opinion-recon-941.md`. Keputusan CTO: perbaiki semua.
- P1 (legend-3wpf dibuka lagi): intent yang dijawab provider `refunded` tidak boleh dilunasi webhook `paid` lama. Bukti `refunded` disimpan; settle menolak bila sudah refunded/failed final. Tidak ada pelunasan tanpa dana.
- P2: hook match basi memakai urutan kunci yang sama dengan penutupan kasus `write_off` (tanpa deadlock).
- legend-l29ln (P3): migrasi 0433 lepas FORCE induk dulu (journal_entries) baru anak; test 0434 sebagai owner biasa pada payment_intents berisi baris.
Jangan sampai rugi: test bukti outlet tidak mencatat lunas tanpa dana dan tidak ada pelunasan ganda, termasuk urutan webhook terbalik.
Paralel: Explore + test-writer (gagal-dulu dari usul test SO) dalam satu giliran, satu implementer per temuan, lalu test-runner + architect xhigh bersamaan.
Bukti: gagal-dulu lalu hijau; test area payment/recon/migrasi lewat heavy setelah commit terakhir; pra-gate AGENTS.md; typecheck API sekali; architect tanpa P1.
Laporan: SHA, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari 3wpf dan l29ln. Lapor sekali di akhir.
