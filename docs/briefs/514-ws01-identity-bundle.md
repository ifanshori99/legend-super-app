# 514 WS-01 identitas: passkey, pilih outlet, audit unlink WA, codec config (tingkat K: akses)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. AGENTS.md proyek berlaku.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin ws/sec-small && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/ws01-identity -b ws/ws01-identity origin/ws/sec-small` (basis memuat WS-01 386d490c yang belum di m1). PORT dan nama DB sendiri. Migrasi sementara hanya 0324-0325.

Kartu (cek `bd show` dan dependensi dulu; kartu yang ternyata terblokir atau butuh founder: lewati dan lapor):
1. legend-jemg: passkey (WebAuthn) enrol + verifikasi untuk MFA staf.
2. legend-6vgv: pilih outlet staf untuk route tanpa outlet (BE + kontrak).
3. legend-7wzy: audit unlink WhatsApp + kontrak otorisasi outlet.
4. legend-tct8: codec section config bundle per domain (TEN-09), kontrak saja.
Paralel: Explore per kartu, test-writer, satu implementer per kartu (file terpisah), lalu subagent architect dengan effort xhigh sejak awal (akses) atas seluruh diff. Temuan nyata dibetulkan.
Bukti: test gagal-dulu per kartu, test isolasi tenant/outlet untuk 6vgv dan 7wzy, tsc paket disentuh, eslint/prettier, test terarah lewat `heavy`, db:generate kosong. Commit per kartu, push ws/ws01-identity (tanpa --force). bd: in_progress lalu review.
Jangan akhiri giliran sambil menunggu job latar: tunggu dengan Monitor di giliran yang sama. Satu laporan akhir: commit per kartu, migrasi, temuan architect, angka subagent (total, puncak, pemegang heavy), yang belum terbukti.
