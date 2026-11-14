# Brief: designer Codex — mockup 6 perbaikan UI ops dan web

## Peran
Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`, lalu ikuti. Jangan menjalankan `bd`; baca kartu lewat `.beads/issues.jsonl` (grep id).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `design/ui-ops-kecil`. Hanya `design/mockups/ops-kecil/`, tanpa kode aplikasi.

## Kartu
legend-lhe4k (sembunyikan halaman template checklist), legend-z274 (kategori notifikasi checklist), legend-1n5z (`dueTime` di bawah cutoff hari bisnis), legend-v99yu (hydration warning — cukup catat bila tidak butuh mockup), legend-5tai0 (toaster menutupi konten), legend-rxida (halaman `/masuk` melebar di 320px). Lihat layar sekarang di `apps/web/src/routes/_ops/` dan gaya mockup ops yang sudah ada di `design/`.

## Tujuan
Satu halaman review HTML: tiap kartu = keadaan sekarang vs usulan (desktop + 390px; rxida juga 320px), satu kalimat alasan, Bahasa Indonesia. Kartu yang tidak butuh keputusan visual ditandai "langsung kerjakan".

## Bukti selesai
`ghostex visual check <file> --out <png>` dan `--width 390` tanpa error, PNG di folder yang sama. Commit + push tanpa force. Laporan: path HTML + PNG.
