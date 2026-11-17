# 987 Fasilitas: jam operasional berlaku-mulai, pengingat min-spend, metrik revpash, tanda menu sarapan

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort high (migrasi; tanpa uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1b0fd2a9e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0570-0574 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-4us1a: jam operasional fasilitas butuh tanggal berlaku (perubahan tidak menimpa jadwal/booking yang sudah lewat atau sudah dikonfirmasi).
- legend-e24cz: WFC `evaluateMinSpend` dipicu terjadwal oleh worker (pengingat min-spend), idempoten, satu pengingat per periode.
- legend-p4q10: metrik harian `revpash` + `seat_occupancy_pct` dihidupkan dan diperbarui (ms-facility/metrics-engine), dengan test angka.
- legend-lgyfh: tanda menu sarapan; sekarang semua menu outlet tampil di alur sarapan. Hanya menu bertanda yang tampil.

Jangan sentuh: refund/charge/payroll (980-985), Tanya AI/MCP (981/984), edge (978), alur pembayaran. UI web hanya bila kartu menuntut dan memakai komponen yang ada (tanpa layar baru).

Bukti: test gagal-dulu per kartu; isolasi tenant/outlet di SQL; worker aman diulang; migrasi dengan default yang tidak mengubah perilaku tenant lama tanpa data.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect high bersamaan. Gate (#9): lint, typecheck API (web bila tersentuh), test terarah grup facility/wfc/breakfast/metrics, `db:generate` kosong, prettier, text-contract bila ada teks UI baru. Satu token heavy per thread; typecheck sekali per putaran perbaikan. Jangan jalankan `pnpm check` atau `pnpm test` penuh (tugas merge train). Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal (tanpa tick).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
