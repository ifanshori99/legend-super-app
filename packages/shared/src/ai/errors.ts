// AI / MCP error codes (docs/plan/contracts.md D-CORE-4: a domain declares
// its own UPPER_SNAKE codes next to its schemas). The API error handler maps
// AiError the same way it maps CoreError.

export const aiErrorHttpStatus = {
  /** AIG-01: the tenant or the feature switch is off. */
  AI_FEATURE_DISABLED: 403,
  /** AIG-01: this tool is turned off by the per-tool kill switch. */
  AI_TOOL_DISABLED: 403,
  /** AIG-02: the daily limit for the caller's role is used up. */
  AI_QUOTA_EXCEEDED: 429,
  /** AIG-04: the monthly AI budget reached the stop threshold. */
  AI_BUDGET_EXCEEDED: 402,
  /** AIG-05: the AI provider is down; the rest of the app keeps working. */
  AI_PROVIDER_UNAVAILABLE: 503,
  /** The request or answer was blocked because it carries personal data. */
  AI_PII_BLOCKED: 422,
  /** The caller's role, outlet scope, or token scope does not allow this tool. */
  AI_TOOL_FORBIDDEN: 403,
  /** AIG-03: a write tool only creates a request; it never changes data directly. */
  AI_WRITE_REQUIRES_APPROVAL: 409,
  /** The action request does not exist or is outside the caller's scope. */
  ACTION_REQUEST_NOT_FOUND: 404,
  /** The action request status does not allow the requested change. */
  ACTION_REQUEST_INVALID_TRANSITION: 409,
  /** MCP-05: the client is not approved by an admin (or was revoked). */
  MCP_CLIENT_NOT_APPROVED: 403,
  /** MCP-02: the token was revoked. */
  MCP_TOKEN_REVOKED: 401,
  /** MCP-02: the token passed its expiry time. */
  MCP_TOKEN_EXPIRED: 401,
  /** MCP-01: the token has no scope for this tool. */
  MCP_SCOPE_INSUFFICIENT: 403,
  /** The MCP per-minute request limit is reached. */
  MCP_RATE_LIMITED: 429,
  /** The conversation does not exist, is deleted, or belongs to another user. */
  AI_CONVERSATION_NOT_FOUND: 404,
} as const satisfies Record<string, number>;

export type AiErrorCode = keyof typeof aiErrorHttpStatus;
export const AI_ERROR_CODES = Object.keys(aiErrorHttpStatus) as AiErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<AiErrorCode, string> = {
  AI_FEATURE_DISABLED: "Fitur AI sedang dimatikan oleh admin.",
  AI_TOOL_DISABLED: "Alat AI ini sedang dimatikan oleh admin.",
  AI_QUOTA_EXCEEDED:
    "Batas pertanyaan AI hari ini sudah habis. Coba lagi besok.",
  AI_BUDGET_EXCEEDED:
    "Anggaran AI bulan ini sudah habis. Hubungi admin untuk menambah.",
  AI_PROVIDER_UNAVAILABLE:
    "Layanan AI sedang tidak tersedia. Fitur lain tetap bisa dipakai.",
  AI_PII_BLOCKED:
    "Permintaan ditolak karena memuat data pribadi yang tidak boleh dikirim ke AI.",
  AI_TOOL_FORBIDDEN: "Anda tidak punya izin memakai alat AI ini.",
  AI_WRITE_REQUIRES_APPROVAL:
    "AI hanya bisa mengajukan perubahan. Perubahan berjalan setelah disetujui.",
  ACTION_REQUEST_NOT_FOUND: "Pengajuan tindakan tidak ditemukan.",
  ACTION_REQUEST_INVALID_TRANSITION:
    "Pengajuan tindakan ini tidak dapat diubah ke status tersebut.",
  MCP_CLIENT_NOT_APPROVED: "Aplikasi MCP ini belum disetujui admin.",
  MCP_TOKEN_REVOKED: "Akses MCP ini sudah dicabut.",
  MCP_TOKEN_EXPIRED: "Akses MCP sudah kedaluwarsa. Sambungkan ulang.",
  MCP_SCOPE_INSUFFICIENT: "Akses MCP ini tidak mencakup alat tersebut.",
  MCP_RATE_LIMITED: "Terlalu banyak permintaan MCP. Coba lagi sebentar lagi.",
  AI_CONVERSATION_NOT_FOUND: "Percakapan AI tidak ditemukan.",
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;

  constructor(code: AiErrorCode, message: string = defaultMessages[code]) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = aiErrorHttpStatus[code];
  }
}
