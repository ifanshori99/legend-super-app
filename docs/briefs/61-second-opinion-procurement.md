# Brief: second-opinion — pengadaan: supplier, PR/PO dengan approval, kirim PO (legend-9yz)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/procurement`, cabang `ws/procurement` (HEAD `ae09d1d`). Diff: `git diff main...ws/procurement` (abaikan snapshot drizzle `meta/*.json` yang besar). Brief engineer asal: `docs/briefs/29-engineer-procurement.md`.

## Fokus (uang, keamanan, data pribadi)
- Approval PR dan PO memakai service approval generik (legend-y5q): approver tidak bisa menyetujui dokumen sendiri, approval sekali pakai, approval tidak lintas tenant atau outlet, nilai approval terikat nilai dokumen.
- Perubahan harga atau nominal PO setelah approval: harus memicu approval ulang atau ditolak.
- Nominal integer IDR; riwayat harga supplier tidak bisa diubah diam-diam.
- Share link PO: hanya hash token yang disimpan; rate limit pada endpoint publik; token kedaluwarsa dan token salah ditolak; token dan PII tidak masuk log atau respons.
- Email supplier lewat worker job: alamat email tidak tercetak di log; job idempoten bila diulang.
- Dokumen PO (PDF): data yang tampil sama dengan data tersimpan; tidak ada bocor data lintas tenant.
- RLS dan isolasi tenant/outlet pada tabel baru; migration aman untuk data lama. Nomor migration yang bentrok dengan cabang lain dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
