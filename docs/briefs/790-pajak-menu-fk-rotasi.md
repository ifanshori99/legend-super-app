# 790 Tiga kartu terpisah: rekap PBJT, FK resep menu, rotasi kunci (tingkat K)

Peran: engineer (baca `~/.agents/team/roles/engineer.md`). Basis: `git fetch origin && git reset --hard origin/milestone/m1` di worktree-mu, lalu cabang `ws/tax-menu-keyrotation`. Satu commit per kartu.

1. legend-jwn6 (pajak/uang): rekap PBJT mencampur gross inclusive dan exclusive (`tax.service.ts` ~1321). Rekap harus konsisten (DPP dan pajak terpisah); test: campuran transaksi inclusive+exclusive, refund, outlet berbeda. Tidak ada pajak yang dilaporkan kurang.
2. legend-3kdd (migrasi): FK komposit (tenant_id, recipe_id) dari menu_items/item_variants/modifiers ke recipes. Migrasi nomor **0374** (0373 dipakai cabang edge). Cek data yatim dulu (NOT VALID + VALIDATE bila perlu), aman di bawah FORCE RLS, `pnpm db:generate` kosong setelahnya.
3. legend-rg8yl (rahasia): `rotateAiProviderKeys` dan `rotateIntegrationCredentials` belum punya pemanggil produksi. Jadwalkan di worker yang ada (idempoten, satu instance via advisory lock), dokumentasikan di `docs/deployment.md`. Jangan pernah log nilai kunci.

Paralel: Explore per kartu, test-writer gagal-dulu, satu implementer per kartu (file terpisah), lalu satu subagent architect effort xhigh atas seluruh diff. Temuan nyata dibetulkan.

Selesai: test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck API sekali), push cabang. Laporan: SHA per kartu, test, hasil architect, angka subagent. Jangan merge ke m1, jangan deploy. Boleh `bd update --claim` dan komentar SHA.
