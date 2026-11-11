# 501 Second opinion Codex: HRIS cuti + reset PIN slip gaji via WhatsApp (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit. Effort xhigh (gaji + data pribadi + akses).

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan (gabungan cabang, satu review per area), masing-masing `git diff origin/milestone/m1...<cabang>`:
- `origin/ws/5nt2z-leave-partial` (cuti sebagian, migrasi 0256-0258 setelah renomor), `origin/ws/3jem1-hr-leave-review-ui` (UI review cuti HR).
- `origin/ws/9h2oj-wa-reset`, `origin/ws/9h2oj-tests`, `origin/ws/ur82k-lupa-pin-ui` (reset PIN slip gaji via WhatsApp, migrasi 0255), `origin/ws/vqvuj-baa-wa-confirm`.
Fokus: cuti mengubah absensi/gaji dengan benar (tidak ada potongan atau bayar ganda), supervisor hanya melihat staf sendiri, reset PIN: pengambilalihan akun lewat nomor WA, enumerasi, replay/brute force kode, rate limit, slip gaji orang lain terbaca, data pribadi di log.

Sudah diketahui (jangan dilaporkan ulang): legend-0c5yg (cuti vs payroll tertutup + fungsi flag 0258, sedang dikerjakan), legend-pyc4t (kontrak OTP mati).

Laporan: temuan P0..P3, file:line, skenario gagal konkret, usul perbaikan. Maks 12, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
