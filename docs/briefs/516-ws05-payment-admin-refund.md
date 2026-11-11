# 516 WS-05 pembayaran: admin routing, dana belum teralokasi, eksekusi refund + matriks approval (uang, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. AGENTS.md proyek berlaku.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/ws05-pay-admin -b ws/ws05-pay-admin origin/milestone/m1`. Cek dulu dependensi kartu (`bd show`, `bd dep`) dan apakah cabang refund/payment yang belum di m1 harus jadi basis; bila ya, pakai cabang itu dan sebutkan di laporan. PORT dan nama DB sendiri. Migrasi sementara hanya 0328-0330.

Kartu (urut, file payment bersinggungan): legend-fuv7 (endpoint admin routing rules + dana belum teralokasi + celah kontrak), legend-lnit (celah admin pembayaran, pengerasan akses), legend-7tc4 (eksekusi refund + matriks approval). Kartu yang butuh keputusan founder: berhenti di bagian itu dan tulis pertanyaannya dengan rekomendasi yang membatasi pembayaran.
Aturan jangan sampai rugi: test gagal-dulu bahwa refund tidak pernah melebihi yang dibayar (termasuk refund paralel dua koneksi dan retry gateway), dana belum teralokasi tidak bisa dialokasikan dua kali, approval matriks tidak bisa dilewati (pembuat != penyetuju, batas nominal), idempotency di semua mutasi uang.
Paralel: Explore per kartu, test-writer, implementer per kartu bila file terpisah, lalu subagent architect effort xhigh sejak awal atas seluruh diff.
Gate: tsc, eslint/prettier, test terarah lewat `heavy`, db:generate kosong. Commit per kartu, push (tanpa --force). bd: in_progress lalu review.
Tunggu job latar dengan Monitor di giliran yang sama. Satu laporan akhir: commit per kartu, migrasi, bukti uang, temuan architect, angka subagent, pertanyaan founder.
