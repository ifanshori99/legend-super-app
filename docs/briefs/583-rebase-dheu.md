# Brief: engineer (Codex) — selaraskan ws/dheu-secrets-support dengan milestone/m1

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Kartu: `bd show legend-dheu legend-tetyr`.

## Masalah
Merge train batch52 berhenti: `endTenantSupportAccess` di m1 (dari HRIS U4, cabut akses dukungan oleh Owner, legend-8iuos) bertabrakan dengan `revokeSupportAccess` di Dheu (ws/dheu-secrets-support 46fe0375) beserta perubahan auditnya. Bukti: `/tmp/batch52-dheu-conflicts.txt` (bila ada), bead `legend-4q4b1`.

## Tujuan
1. Worktree basis `milestone/m1` terbaru. Cabang `ws/dheu-m1`. Merge `ws/dheu-secrets-support`, selesaikan konflik jadi SATU jalur cabut akses dukungan: hanya Owner aktif dengan MFA (perilaku m1 yang lolos second opinion), efektif segera, grant diperiksa ulang tiap request, satu entri audit per pencabutan (tidak dobel, tidak hilang). Fitur rotasi kunci Dheu (previous-key fallback, `db:rotate-data-key`) tetap utuh.
2. Migrasi 0287 Dheu: biarkan nomornya; merge train yang menomori ulang. Pastikan tidak bentrok dengan kolom/tabel yang sudah ditambah 0308 (HRIS U4).
3. Test: test cabut akses m1 + test Dheu lulus; tambah test: dua jalur lama tidak bisa dipakai untuk melewati syarat Owner/MFA.

## Bukti selesai
- Test terarah lulus, typecheck api/shared/web, ESLint + Prettier, `db:generate` kosong.
- Satu subagent architect effort xhigh (akses + migrasi) mereview resolusi konflik.
- Push `ws/dheu-m1`. Jangan `pnpm check` penuh, jangan sentuh milestone/m1 atau main.
