# Brief: engineer (Claude Sonnet) — backend tombol darurat edge (legend-bod.2-.5)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Tingkat K akses.

## Sumber
- Desain: `docs/design/edge-emergency.md` di `origin/design/qris-dp-edge-emergency` (d4840228). Kartu E1-E4: `bd show legend-bod.2 legend-bod.3 legend-bod.4 legend-bod.5`. Titik TBD-verify dicek dulu (kredensial penyedia di edge, origin web di edge).
- Keputusan founder Q94-Q95: `bd memories founder-q92-q95` (fallback ke semua layar POS setelah 15 detik, nama ruangan + jam; penerima FA/supervisor/OM/GM on-duty, tutup insiden hanya OM/GM di cloud).
- Brief engineer lama + draf relay WIP: `docs/briefs/565-edge-emergency.md`, cabang `origin/ws/edge-emergency` bila ada (ambil yang berguna, desain baru menang).
- Test gagal-dulu di cabang basis: baca "Assumptions" di header test dan `panic-test-helpers.ts` dulu; samakan nama/bentuk body dengan test.

## Repo
Worktree basis `test/edge-emergency` (17c22875). Cabang `ws/edge-emergency-impl`. Migrasi **0400-0402** saja. Jangan sentuh pajak, payroll, refund, poin, Better Auth.

## Kerja
E1 (sesi penerima PIN: cookie HttpOnly hash SHA-256, hak sempit, tidak bisa dipakai absen) → E2 (fan-out on-duty <=5 detik dengan tanda terima, kirim ulang 3 detik, fallback 15 detik ke layar POS, cek Origin WebSocket), E3 (sinkron cloud tanpa duplikat lewat antrean keluar edge, `panic_press_events`), E4 (tutup insiden di cloud oleh OM/GM) paralel setelah E1. Satu implementer per kartu, file terpisah.

## Bukti selesai
- 152 test edge di cabang basis hijau lewat `LEGEND_TEST_FILES=... heavy pnpm test`. Assertion tidak dilonggarkan.
- Pra-gate AGENTS.md hijau, `db:generate` kosong. Satu subagent architect effort xhigh (akses + migrasi).
- Commit + push tanpa --force. Jangan merge. Lapor SHA, angka subagent, perubahan dari asumsi test.
