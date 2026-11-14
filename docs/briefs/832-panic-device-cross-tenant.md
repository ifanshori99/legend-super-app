# Brief: engineer — perangkat alarm panik lintas tenant

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru dari `origin/fix/panic-push-device-revoke` (dd04533e1), cabang `fix/panic-device-cross-tenant`.

## Tujuan
User multi-tenant bisa melihat dan mencabut HP alarm panik miliknya yang terdaftar di tenant lain, tanpa membuka data perangkat user lain atau tenant lain.

## Kartu
`legend-fonnr`. Di awal: `ghostex board associate legend-fonnr` dan `bd update legend-fonnr --status in_progress`. Saat lapor: `bd update legend-fonnr --status review` + `bd comment`.

## Aturan
- Fungsi SECURITY DEFINER sempit: hanya baris milik `auth user id` pemanggil, `search_path` dikunci, tanpa parameter owner dari klien.
- Cabut perangkat juga mengakhiri sesinya (keputusan CTO).
- Migrasi: hanya 0380. Jangan ubah UI (layar "Perangkat alarm panik" sedang di review founder Q4); cukup API + kontrak bila UI sudah memanggil endpoint yang ada.

## Pembagian paralel (giliran pertama)
- Explore (2): skema/RLS perangkat panik; route + service cabut perangkat.
- test-writer: test isolasi (user A tidak lihat HP user B; tenant lain milik A terlihat; cabut lintas tenant mengakhiri sesi), gagal-dulu terhadap base.
- implementer (2): migrasi + fungsi; service/route.
- Pemegang heavy: satu test-runner. Review akhir: subagent architect effort xhigh (akses + migrasi).

## Bukti selesai
- Test terarah hijau lewat heavy; `pnpm db:generate` kosong; pra-gate AGENTS.md.
- Push tanpa force; laporan dengan angka subagent.
