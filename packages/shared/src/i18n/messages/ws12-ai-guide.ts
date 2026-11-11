// WS-12 Tanya AI & MCP UI text, part "guide" (brief docs/briefs/sub-539-u3-ai-mcp.md).
// Own file so the parallel WS-12 UI beads never edit the same lines in id.ts.
// Namespace: `aiGuide`. Copy follows the approved mockup design/mockups/ai/panduan.html;
// the guideline paragraphs themselves come from GET /api/ai/guidelines.

export const aiGuideMessages = {
  title: "Pedoman penggunaan AI",
  subtitle: "Cara menggunakan Tanya AI dengan aman dan memahami hasilnya.",
  back: "Kembali ke Tanya AI",
  aboutEyebrow: "Tentang Tanya AI",
  points: {
    titleFour: "Empat hal yang perlu diingat",
    titleOther: "Hal yang perlu diingat",
    subtitle: "Panduan ini berlaku untuk semua pengguna Tanya AI.",
  },
  loading: "Memuat pedoman penggunaan AI",
  errorTitle: "Pedoman belum bisa dimuat",
  errorHint:
    "Periksa koneksi internet Anda, lalu coba lagi. Anda tetap bisa kembali ke Tanya AI.",
} as const;
