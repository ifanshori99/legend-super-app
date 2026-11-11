# 494 Temuan second-opinion public edge + keputusan CTO

Sumber: Codex G3mwt, review ce080d9d. Kerjakan di cabang `ws/public-ratelimit` (worktree `.worktrees/public-ratelimit`). Test gagal-dulu tiap temuan, reviewer sonnet sekali, commit, push, lapor dengan angka subagent.

1. P2 `shared-window-store.ts:171` + `public-rate-limit.ts:318`: kunci Redis limiter publik dan guest bertabrakan. Keputusan: namespace kunci per limiter (`public:`, `guest:`, `booking:` dst.). Test: polling guest tidak menghabiskan anggaran publik pada store bersama.
2. P2 `public-rate-limit.ts:333` + `shared-window-store.ts:168`: bearer acak membuat kunci tak terbatas sebelum cek IP/tenant. Keputusan: cek batas IP dan tenant dulu, baru buat kunci kredensial; kunci kredensial memakai hash bearer dan hanya dibuat untuk bearer yang lolos cek format; batas kardinalitas per IP. Test: banjir bearer acak setelah 429 tidak menambah kunci.
