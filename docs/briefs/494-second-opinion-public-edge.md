# 494 Second opinion Codex: public edge rate-limit + IP SSR + cache HTML (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit. Effort high (keamanan: header IP tepercaya, cache publik).

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan: `git diff origin/milestone/m1...origin/ws/public-ratelimit` (ce080d9d: legend-bpvf Redis shared window, legend-moe5 IP pengunjung dari SSR via `SSR_SHARED_SECRET`, legend-vz93 HTML publik bisa di-cache).
Fokus: pemalsuan IP (header dari klien, `TRUST_PROXY`/`WEB_TRUST_PROXY_HOPS`, perbandingan secret), bypass rate-limit, fail-open Redis yang bisa disalahgunakan, kebocoran antar tenant lewat cache (Vary Host, Cookie, Set-Cookie, respons degraded atau error ter-cache), data pribadi di HTML yang di-cache, dependensi `ioredis`.

Sudah diketahui (jangan dilaporkan ulang): firewall origin wajib hanya IP Cloudflare; purge cache saat menu berubah belum ada (maks ~6 menit basi); `perContact` booking tetap lokal per proses; Redis belum diuji dengan server sungguhan.

Laporan: temuan P0..P3, file:line, skenario gagal konkret, usul perbaikan. Maks 12, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
