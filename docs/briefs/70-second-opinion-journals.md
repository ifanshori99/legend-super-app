# Brief: second-opinion — jurnal manual dan berulang (legend-vmyg) — PRIORITAS

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/journals`, cabang `ws/journals` (HEAD `aafe04c`, dari `main`). Diff: `git diff main...ws/journals` (abaikan snapshot drizzle `meta/*.json` yang besar). Brief engineer: `docs/briefs/58-engineer-journals.md`. Kartu: `legend-vmyg`.

File inti yang harus dibaca:
- `apps/api/src/services/accounting-journal-manual.service.ts` (validasi debit = kredit, integer IDR, state machine, pembuat ≠ approver)
- `apps/api/src/services/accounting-journal-recurring.service.ts` (job berulang, lewati periode, resume)
- `apps/api/src/services/accounting-journal-approver.ts` (`approverMayPostJournal`)
- `apps/api/src/services/accounting-journal-period-gate.ts` (`assertJournalPeriodPostable`)
- `apps/api/src/routes/accounting-journal.routes.ts`, `apps/api/src/routes/accounting.routes.ts`
- Migration baru: `apps/api/drizzle/0063_accounting_journal_requests.sql`, `0064_accounting_journal_requests_rls.sql`, `0065_recurring_journal_skips.sql`
- Test: `apps/api/src/test/accounting-journal.test.ts`

Konteks: `docs/PRD.md` §3 F19 (Jurnal Manual & Berulang) dan F7 (Kotak Approval); kontrak di `docs/plan/contracts.md`.

## Fokus (area uang, wajib diverifikasi)
1. **Seimbang**: total debit = total kredit, semua nilai integer IDR, tidak ada jalur yang menerima jurnal tidak seimbang (termasuk lewat baris dengan nilai nol, negatif, atau pecahan). Cek juga jalur berulang: template yang tidak seimbang tidak bisa dijadwalkan.
2. **Pembuat ≠ approver**: dicek di service, di state machine, dan di constraint DB. Pastikan ada batas keras di DB (bukan hanya `if` di kode), dan bahwa pembuat tidak bisa lolos lewat approval chain yang memakai role matrix `manual_journal`.
3. **Approver final**: harus memegang `accounting.journal.post` untuk outlet header dan untuk setiap outlet baris (`approverMayPostJournal`). Outlet null berarti tenant-wide. Cek: user dengan izin hanya di outlet A tidak bisa posting jurnal yang satu barisnya ke outlet B. Deny by default bila tidak ada assignment.
4. **Ledger hanya setelah approval**: tidak ada baris ledger sebelum status disetujui. Ledger append-only; koreksi lewat jurnal pembalik, bukan update.
5. **Approval ganda dan konkuren**: dua approval bersamaan, atau approve dua kali oleh orang yang sama, hanya menghasilkan satu posting. Cek lock dan unique constraint, serta tidak ada deadlock. Test race dengan dua transaksi DB.
6. **Job berulang idempoten**: kunci unik per template + periode (termasuk `tenant_id`). Job yang jalan dua kali, atau dua worker bersamaan, tidak menggandakan jurnal. Job bisa dilanjutkan (resumable) setelah dihentikan di tengah.
7. **Resume setelah pause**: bulan yang sudah di-pause (skip) dilewati saat job dilanjutkan, tidak diposting dan tidak dihitung ulang.
8. **Endpoint skip-period** (migration `0065_recurring_journal_skips.sql`):
   - hanya boleh melewati periode berikutnya yang sudah jatuh tempo dan sudah ditutup (closed month), bukan bulan lain;
   - butuh permission yang benar, dan dicek di route (`requirePermission`) serta service;
   - tercatat di audit;
   - idempoten: skip yang sama diulang tidak mengubah apa pun dan tidak membuat audit ganda.
9. **Gate periode**: `assertJournalPeriodPostable` harus dipanggil di setiap jalur (submit, approve, generate terjadwal) sebelum menyentuh ledger. Saat ini ia mendelegasikan ke `assertPeriodOpenForPosting`. Catatan: brief engineer menyebut kunci periode dari `ws/fiscal-close-lock` akan disambung saat merge, tetapi per pemeriksaan tidak ada referensi `fiscal-close-lock` atau `assertJournalPeriodPostable` di `main` (`apps/api/src`). Verifikasi: apakah `ws/fiscal-close-lock` sudah ada di `main` (`git log main --oneline -- apps/api/src`), dan apakah titik sambung di period gate sudah benar terhadap kunci yang ada di sana. Laporkan status ini apa adanya.
10. **RLS dan isolasi tenant** pada 3 tabel baru: `tenant_id` NOT NULL, RLS aktif dan FORCE, unique memasukkan `tenant_id`, policy memakai konteks tenant yang benar. Cek juga query service: setiap read/update/delete memfilter tenant dan pemilik.
11. **Migrasi 0063–0065**: periksa isinya, pastikan aman untuk data lama, dan tandai migration yang tidak bisa dibatalkan. Nomor 0063+ juga dipakai worktree lain (mis. `ws/pos-shift` memakai 0063–0067 dan `ws/kds`). Cek `apps/api/drizzle/meta/_journal.json` terhadap `main`. Nomor yang bentrok dirapikan saat merge; itu bukan temuan, tetapi catat urutannya. Jangan menilai `_journal.json` sebagai temuan kecuali ada entri yang rusak.

## Test
- Cek bahwa test benar-benar membuktikan klaim di atas, bukan hanya happy path: jurnal tidak seimbang ditolak; approval oleh user lain; pembuat ditolak menyetujui; ledger hanya setelah approval; posting dobel tidak menggandakan; job berulang idempoten dan resumable; skip-period; isolasi tenant.
- Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`). Build dan test berat lewat `heavy <perintah>`. Bersihkan sesudahnya.
- Jangan baca `.env*`.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. Untuk tiap fokus 1–11: tertutup, belum, atau tidak bisa diverifikasi (dengan alasan). Sebutkan status sambungan `fiscal-close-lock` secara terpisah. "Tidak ada blocker" bila memang tidak ada.
