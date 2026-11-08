# Brief 89b: regen migration satu cabang di atas m1 (subagent implementer)

Konteks: merge train ke `milestone/m1` (brief 89, aturan "Catatan merge milestone" di `docs/PROGRESS.md`). Worktree prep cabang sudah berisi merge m1 (lihat SHA base di prompt) dan SQL migration milik cabang masih di nomor lama, di luar `_journal.json`. Contoh hasil yang benar: `.worktrees/journals/apps/api/drizzle/0075_eager_living_lightning.sql` + `0076_accounting_journal_requests_rls.sql` (commit 4ec3babb).

## Langkah (hanya di worktree prep yang disebut di prompt)
1. Catat isi SQL milik cabang (nama file disebut di prompt). Simpan salinan di `/tmp` tidak boleh; pakai `git show HEAD:<path>` saat butuh.
2. Hapus SQL milik cabang itu (snapshot meta milik cabang sudah diganti sisi m1).
3. `pnpm db:generate` (dari root worktree). drizzle-kit membuat migration baru (nomor berikut setelah entri terakhir journal, `when` baru > milik m1) dari diff schema TS. Bila drizzle-kit bertanya interaktif (rename/create), jawab "create" — bila tidak bisa non-interaktif, berhenti dan lapor.
4. Bandingkan SQL baru dengan SQL lama cabang: tabel, kolom, index, FK, CHECK harus setara. Perbedaan: lapor.
5. FK ke tabel ber-FORCE RLS (mis. `outlets`, `legal_entities`, `employees`, `payment_intents`, `tenant_integrations`, `journal_entries`, dll — cek di SQL lama cabang mana yang dibungkus NO FORCE): sisipkan pola 0065/0068 ke migration baru: `ALTER TABLE public.<t> NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint` sebelum blok `ADD CONSTRAINT ... FOREIGN KEY`, dan `ALTER TABLE public.<t> FORCE ROW LEVEL SECURITY;--> statement-breakpoint` sesudahnya, plus komentar alasan (salin dari SQL lama cabang). Untuk tiap tabel referensi yang SQL lama bungkus, dan juga tabel FORCE RLS lain yang jadi target FK baru.
6. SQL custom (RLS, REVOKE, trigger, backfill): `pnpm --filter @starter/api exec drizzle-kit generate --custom --name <nama_cabang>_rls` lalu salin isi custom dari SQL lama ke file itu apa adanya.
7. Cek `apps/api/drizzle/meta/_journal.json`: entri baru `when` naik monoton dan > entri m1 terakhir.
8. Verifikasi migrate di DB sekali pakai: `heavy node /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/08f54ec9-05a9-40d0-adde-05da14953610/scratchpad/run-tests-existing-pg.mjs "$PWD" starter-pg-test-96e8cf6ecb7e7faa-postgres-1 33115 src/test/edge-received-events-migration.test.ts <test migration/DB cabang 1-3 file>` (runner ini membuat DB sendiri di container yang port-nya masih jalan; `pnpm test` biasa sedang rusak karena port-forward Colima untuk container baru gagal). Output difilter (`grep -E "Test Files|Tests  |RUNNER|EXIT|×"`).
9. `heavy pnpm -s typecheck` bila ada file TS berubah.
10. Commit lokal di cabang prep: `merge-prep: regen <cabang> migrations as NNNN/NNNN on m1 <base>`. Jangan push. Jangan sentuh worktree lain. Jangan `pkill`/`killall`.

## Laporan singkat
SHA commit, nama migration baru + `when`, tabel yang dibungkus NO FORCE/FORCE, perbedaan SQL lama vs baru, hasil test yang dijalankan.
