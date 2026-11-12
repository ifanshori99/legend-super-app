# 539-U3 founder review page Q52 (Tanya AI, ChatGPT style)

Goal: one Ghostex page for the founder (non-technical, Indonesian) to review ONLY the redesigned Tanya AI screens. Write `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp/docs/review/539-u3-tanya-ai-q52.html`. Do not publish (`ghostex show` forbidden). Do not commit.

Template: copy structure and CSS of `docs/review/539-u3-ai-mcp.html` (same folder): `<meta name="ghostex-page" content="v2">`, `<gx-questions submit="Kirim ke tim">`, header eyebrow/h1/lede, `<section data-question="Q52" data-choice="Setujui">` wrapping heading, text, `<gx-wide>` with desktop figures and a `.gx-grid` of phone figures (same inline grid style as the template). Rules: `~/.agents/skills/ghostex-visuals/SKILL.md` sections "Ghostex pages", "Phones", "Images, sandbox, publishing", "Ghostex pages with questions".

Title: "Review ulang Tanya AI (gaya ChatGPT)". Lede: per your 12 Nov note, Tanya AI now looks like ChatGPT: question box at the bottom center, conversation history on the left (on a phone it opens as a slide panel from "Riwayat"), answers flow in the middle, an empty screen shows example questions. Same page for all five areas. Example data.

Images (absolute paths `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp/output/ui-check-ai-mcp/<name>.png`, each in `<figure class="gx-figure">` + short Indonesian figcaption):
- Desktop: `tanya-ai-1440` (Kelola, with a conversation), `tanya-ai-empty-1440` (new conversation with example questions), `tanya-ai-kuota-1440` (quota reached banner above the box).
- Phone: `tanya-ai-390`, `tanya-ai-empty-390`, `tanya-ai-karyawan-390` (Karyawan area), `tanya-ai-kds-390` (Dapur area).
Keep total images under ~3 MB.

One question only: `<gx-question tag="Q52" title="Tanya AI gaya ChatGPT sudah sesuai?">` with `<gx-choice value="Setujui" recommended>Setujui<small>Lanjut ke tahap berikutnya.</small></gx-choice><gx-choice value="Ubah">Ubah<small>Tulis perubahan di catatan.</small></gx-choice>`.

Short plain list "Yang perlu diketahui": riwayat hanya terlihat oleh pemiliknya; jawaban tetap memakai label "Dibantu AI" dan sumber; contoh pertanyaan berbeda per area (pengelola, pemegang saham, karyawan, dapur).

Check: `ghostex visual check <file>` and `ghostex visual check <file> --width 390`; fix until no errors/warnings. Report: path + check summary.
