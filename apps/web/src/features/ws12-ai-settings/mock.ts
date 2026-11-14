// Mock handlers for Pengaturan AI (VITE_API_MOCK=true): custom provider with
// detected capabilities, and the ChatGPT device-code login. Budget comes
// from features/ws12-ai-admin/mock.ts.
//
// Scenario URLs (page /kelola/pengaturan/ai):
//   ?state=empty|device|connected|failed|expired|detected   starting state
//   ?state=disabled       platform lock (provider platformLocked), saved settings
//   ?state=loading|offline|session   page gate: never answers / no connection / 401
//   ?role=owner|admin     owner may connect/revoke ChatGPT, admin may not
//   ?ai=off               same kill switch on any state
//   ?mock=slow|error|offline|empty    generic scenarios (lib/mock/control.ts)
// Defaults: empty state as owner. A pending code turns connected after
// POLLS_TO_CONNECT polls so the whole flow can be walked by hand.
import { ApiError, NETWORK_ERROR_MESSAGE } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { zodIssuesToDetails } from "@starter/shared/api";
import {
  aiErrorHttpStatus,
  aiModelCapabilityOverridesSchema,
  getAiProviderConfig,
  getChatgptLogin,
  patchAiProviderConfig,
  pollChatgptLogin,
  revokeChatgptLogin,
  startChatgptLogin,
  testAiProviderConfig,
  upsertAiProviderConfig,
  type AiModelCapabilities,
  type AiModelCapabilityOverrides,
  type AiProviderConfig,
  type ChatgptLoginStatus,
} from "@starter/shared/ai";

const POLLS_TO_CONNECT = 2;
const DEVICE_URL = "https://auth.openai.com/codex/device";

function urlParam(name: string): string | null {
  const search = (globalThis as { location?: { search?: string } }).location
    ?.search;
  return search === undefined ? null : new URLSearchParams(search).get(name);
}

const now = () => new Date().toISOString();
const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();

const DETECTED: AiModelCapabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsReasoning: true,
  reasoningEfforts: ["low", "medium", "high"],
  source: "metadata",
};

const readyConfig = (): AiProviderConfig => ({
  connectionType: "api_key",
  baseUrl: "https://model.example.com/v1",
  defaultModel: "model-outlet",
  capabilities: DETECTED,
  capabilityOverrides: null,
  hasKey: true,
  keyLast4: "ab12",
  keySetAt: now(),
  lastTest: { status: "ok", testedAt: now(), errorCode: null },
  updatedAt: now(),
});

type MockState = {
  config: AiProviderConfig | null;
  login: ChatgptLoginStatus;
  polls: number;
};

const loginOf = (
  state: ChatgptLoginStatus["state"],
  canManage: boolean,
): ChatgptLoginStatus => ({
  state,
  platformDisabled: false,
  viewerCanManage: canManage,
  deviceCode: state === "pending" && canManage ? "LGND-4826" : null,
  verificationUrl: state === "pending" && canManage ? DEVICE_URL : null,
  expiresAt: state === "pending" ? inMinutes(15) : null,
  connectedAt: state === "connected" ? now() : null,
  riskAcceptedAt: state === "disconnected" ? null : now(),
});

const seed = (): MockState => {
  const canManage = urlParam("role") !== "admin";
  const start = urlParam("state") ?? "empty";
  const loginState: ChatgptLoginStatus["state"] =
    start === "device"
      ? "pending"
      : start === "connected" || start === "detected"
        ? "connected"
        : start === "disabled"
          ? "connected"
          : start === "failed" || start === "expired"
            ? start
            : "disconnected";
  return {
    config: start === "detected" || start === "disabled" ? readyConfig() : null,
    login: loginOf(loginState, canManage),
    polls: 0,
  };
};

const store = createMockStore(seed);

/** Platform lock for this tenant: `?state=disabled` or `?ai=off` on any state. */
const platformLocked = () =>
  urlParam("ai") === "off" || urlParam("state") === "disabled";

/**
 * Page gate states of the mockup. The two status reads (provider and ChatGPT)
 * decide the page, so only they act out `loading`, `offline` and `session`.
 */
async function pageGate(): Promise<void> {
  const state = urlParam("state");
  if (state === "loading") await new Promise<never>(() => undefined);
  if (state === "offline")
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  if (state === "session")
    throw new ApiError(401, "UNAUTHENTICATED", "Sesi Anda sudah habis.");
}

registerMock(getAiProviderConfig, async ({ scenario }) => {
  await pageGate();
  return {
    data: {
      config: scenario === "empty" ? null : store.get().config,
      fallbackAvailable: false,
      platformLocked: platformLocked(),
    },
  };
});

registerMock(upsertAiProviderConfig, ({ body }) => {
  const state = store.get();
  const prev = state.config;
  if (!prev && body.apiKey === undefined)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Masukkan kunci akses dari penyedia model.",
      [
        {
          field: "apiKey",
          message: "Masukkan kunci akses dari penyedia model.",
        },
      ],
    );
  const overrides =
    body.capabilityOverrides === undefined
      ? (prev?.capabilityOverrides ?? null)
      : body.capabilityOverrides;
  const config: AiProviderConfig = {
    ...(prev ?? readyConfig()),
    baseUrl: body.baseUrl,
    defaultModel: body.defaultModel,
    capabilityOverrides: overrides,
    ...(body.apiKey
      ? {
          hasKey: true,
          keyLast4: body.apiKey.slice(-4),
          keySetAt: now(),
          lastTest: null,
        }
      : {}),
    updatedAt: now(),
  };
  store.set({ ...state, config });
  return {
    data: {
      config,
      fallbackAvailable: false,
      platformLocked: platformLocked(),
    },
  };
});

/** Same merge as the API's mergeCapabilityOverrides: undefined fields are dropped. */
function mergeOverrides(
  previous: AiModelCapabilityOverrides | null,
  patch: AiModelCapabilityOverrides | null | undefined,
): AiModelCapabilityOverrides | null {
  if (patch === undefined) return previous;
  if (patch === null) return null;
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(fields).length === 0) return previous;
  const result = aiModelCapabilityOverridesSchema.safeParse({
    ...previous,
    ...fields,
  });
  if (!result.success)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Input tidak valid.",
      zodIssuesToDetails(result.error),
    );
  return result.data;
}

registerMock(patchAiProviderConfig, ({ body }) => {
  const state = store.get();
  const prev = state.config;
  if (!prev)
    throw new ApiError(
      aiErrorHttpStatus.AI_PROVIDER_NOT_CONFIGURED,
      "AI_PROVIDER_NOT_CONFIGURED",
      "Provider AI belum diatur untuk tenant ini.",
    );
  const previous = prev.capabilityOverrides;
  const merged = mergeOverrides(previous, body.capabilityOverrides);
  // No-op edit: the row stays as it was, updatedAt included.
  if (JSON.stringify(previous) === JSON.stringify(merged))
    return {
      data: {
        config: prev,
        fallbackAvailable: false,
        platformLocked: platformLocked(),
      },
    };
  const config: AiProviderConfig = {
    ...prev,
    capabilityOverrides: merged,
    updatedAt: now(),
  };
  store.set({ ...state, config });
  return {
    data: {
      config,
      fallbackAvailable: false,
      platformLocked: platformLocked(),
    },
  };
});

registerMock(testAiProviderConfig, () => {
  const state = store.get();
  if (!state.config)
    throw new ApiError(409, "CONFLICT", "Simpan model kustom lebih dulu.");
  const lastTest = { status: "ok" as const, testedAt: now(), errorCode: null };
  store.set({ ...state, config: { ...state.config, lastTest } });
  return { data: lastTest };
});

registerMock(getChatgptLogin, async () => {
  await pageGate();
  return { data: store.get().login };
});

registerMock(startChatgptLogin, () => {
  const state = store.get();
  if (!state.login.viewerCanManage)
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Hanya pemilik tenant yang dapat menghubungkan akun ChatGPT.",
    );
  const login = loginOf("pending", true);
  store.set({ ...state, login, polls: 0 });
  return { data: login };
});

registerMock(pollChatgptLogin, () => {
  const state = store.get();
  if (state.login.state !== "pending") return { data: state.login };
  const polls = state.polls + 1;
  const login =
    polls >= POLLS_TO_CONNECT
      ? loginOf("connected", state.login.viewerCanManage)
      : state.login;
  store.set({ ...state, login, polls });
  return { data: login };
});

registerMock(revokeChatgptLogin, () => {
  const state = store.get();
  if (!state.login.viewerCanManage)
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Hanya pemilik tenant yang dapat mencabut akun ChatGPT.",
    );
  const login = loginOf("disconnected", true);
  store.set({ ...state, login, polls: 0 });
  return { data: login };
});
