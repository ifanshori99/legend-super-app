# Brief Codex 177b: second opinion cek tumpang-tindih aturan pajak (legend-de3b)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only; jangan commit.

Repo: `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/tax-rule-overlap` (worktree `.worktrees/tax-rule-overlap`), diff terhadap `ws/provisioning-race` (`git diff bd62055c...ws/tax-rule-overlap`).

Latar: `docs/briefs/177-tax-rule-overlap.md` (keputusan CTO), `docs/briefs/sub-177-tax-rule-overlap.md` (kontrak). Pola acuan: service charge legend-mdh0 (`assertNoServiceChargeOverlap`).

Yang diubah:
- `packages/shared/src/tax/overlap.ts`: `taxRuleTie`, `findTaxRuleTies` (memakai `resolveTaxRule` asli, berpasangan, per tanggal berlaku).
- `publishTaxRule` menolak aturan aktif yang seri dengan aturan aktif lain (409 `TAX_RULE_AMBIGUOUS`, menyebut kode aturan lawan), di bawah kunci `lockTaxConfig`.
- `GET /tax/rules/conflicts` dan banner di halaman aturan pajak untuk data lama yang sudah ganda.

Periksa:
1. Adakah kombinasi (channel, region, item/kategori/kelas item, outlet, tanggal berlaku ke depan) yang masih lolos publish tetapi membuat `resolveTaxRule` melempar `TAX_RULE_AMBIGUOUS` saat order? Adakah false positive yang menolak konfigurasi sah?
2. Jalur lain yang bisa membuat aturan aktif ganda tanpa melewati `publishTaxRule` (provisioning, seed, import, edge sync).
3. Race dua publish bersamaan: apakah keduanya bisa lolos?
4. Daftar konflik: lengkap per outlet, tidak bocor antar tenant, izin sama dengan daftar aturan.

Hasil: tulis `docs/briefs/177b-second-opinion-tax-rule-overlap.result.md`, format seperti hasil 130/122 (P0/P1/P2, file:line, skenario, fix).
