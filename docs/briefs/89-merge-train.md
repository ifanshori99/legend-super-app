# Brief 89: merge train ke milestone/m1

Peran: engineer (merge). Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md` dulu. Tingkat K (migrasi).

## Tujuan
Gabungkan semua cabang yang sudah lolos review ke `milestone/m1` (worktree `.worktrees/milestone-m1`, head 8e2e7bc0) secepat mungkin tanpa merusak gate. CTO tidak lagi merge sendiri.

## Antrean (urutan siap)
journals (ws/journals; CTO sedang regen migration di atas 8e2e7bc0, tunggu SHA dari CTO lalu merge pertama), hris-leave, refund-approval, hris-sop, edc-framework (a6d022d3), payroll-pph21-tests, pos-shift (tunggu fix approvalRequestId dari thread pos-shift), doit-provider (8fed84ef), pos-receipt (tunggu thread struk), procurement, kds (tunggu thread masing-masing). Status tiap cabang: tabel v3.3 di `docs/PROGRESS.md`.

## Cara kerja paralel
- Bagian serial hanya ini: regen migration di atas head m1 terbaru lalu merge. Aturannya ada di "Catatan merge milestone" di PROGRESS.
- Paralel, sebelum giliran merge tiap cabang: satu `implementer` per cabang di `isolation: worktree`.
  - Merge m1 terbaru ke salinan cabang itu.
  - Selesaikan konflik kode (bukan migration).
  - Jalankan test yang terdampak lewat `test-runner`.
  - Laporkan konflik semantik.
- Saat giliran merge tiba, cabang tinggal regen migration (`pnpm db:generate`, `when` > milik m1) lalu merge.
- Setelah tiap merge: `heavy pnpm check` (latar), lalu cabang berikut regen. Gate gagal: perbaiki dulu, jangan lanjut.
- Pakai kumpulan test `edge-received-events-migration.test.ts`. Tiap migration baru dengan FK di bawah FORCE RLS wajib memakai pola 0065/0068.

## Setelah tiap merge
- Tutup kartu bd milik cabang itu. Daftarnya ada di "Rekonsiliasi papan 23:25" di PROGRESS.
- Perbarui tabel v3.3 (SHA merge).
- Ganti SHA di brief second-opinion Codex yang sesuai (59, 60, 62, 63, 65, 68, 70, 61) ke SHA cabang yang digabung.
- Commit lokal. Jangan push. Jangan merge ke `main`.

## Laporan
Lapor ke CTO setiap 3 merge. Isinya:
- SHA merge.
- Migration yang terpakai.
- Hasil gate.
- Kartu yang ditutup.
- Cabang yang tertahan, beserta alasannya.
