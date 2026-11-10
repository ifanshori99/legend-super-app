# Brief Codex 173b: second opinion provisioning race (legend-dq0n, legend-hd1m)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only; jangan commit.

Repo: `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/provisioning-race` (worktree `.worktrees/provisioning-race`), diff terhadap `milestone/m1` (`git diff milestone/m1...ws/provisioning-race`).

Latar: `docs/briefs/130-second-opinion-tax-default.result.md` (P1 race backfill pajak vs owner), `docs/briefs/122-second-opinion-provisioning.result.md` (P2 race CoA; tipe lokasi wajib terlewat karena nama bentrok).

Yang diubah:
- `apps/api/src/services/tenant-config-locks.ts`: satu pola advisory lock (xact, `hashtextextended(key,0)`), urutan 1 CoA per entitas, 2 lokasi per outlet, 3 pajak per tenant, 4 service charge per tenant. Kunci tidak berubah dari versi lama.
- Penulis owner pajak (`tax.service.ts`) dan CoA (`accounting-accounts.service.ts`) kini mengambil lock yang sama dengan provisioning/backfill.
- Lokasi: tipe standar yang namanya dipakai kini tetap ditambah dengan nama alternatif deterministik (`Dapur 2`, ...).
- Test race baru `apps/api/src/test/provisioning-race.test.ts` (dua transaksi, `pg_locks`).

Periksa:
1. Masih adakah jalur tulis owner/edge/import ke `tax_rules`, `tax_settings`, `chart_of_accounts`, `account_mappings` yang tidak mengambil lock (termasuk `edge/master-sync.ts`)? Mungkinkah backfill tetap menyisipkan default saat tenant sudah punya konfigurasi?
2. Urutan kunci: adakah transaksi yang memegang dua lock ini dalam urutan terbalik, atau lock advisory diambil setelah row lock `FOR UPDATE` sehingga bisa deadlock?
3. Nama lokasi alternatif: unik case-insensitive, deterministik, panjang aman, baris lama tidak berubah; production order menemukan tepat satu dapur.
4. Test race benar-benar gagal tanpa fix dan lulus dengan fix.

Hasil: tulis `docs/briefs/173b-second-opinion-provisioning-race.result.md`, format seperti hasil 130/122 (P0/P1/P2, file:line, skenario, fix).
