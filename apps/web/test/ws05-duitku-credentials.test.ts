// legend-vntqt: Duitku credentials form + connection test (sub-302 D15-D16).
// Expected behavior comes from docs/briefs/sub-302-design.md D15-D16, the
// shared contract (GATEWAY_CREDENTIAL_SPECS, upsertIntegrationInputSchema,
// integrationConnectionTestSchema) and the UI copy catalog
// packages/shared/src/i18n/messages/ws05-duitku-credentials.ts.
//
// There is no DOM in web unit tests (environment: node). This file drives the
// real panel with a small harness: react hooks keep their state between
// server-render passes, react-query hooks run the query/mutation functions, and
// only the transport (apiFetch) is faked, so assertions are about what the user
// sees and which HTTP calls the panel makes. Handlers are looked up by the
// visible label or button text, never by CSS.
//
// Assumptions (spec silent):
//  - The panel takes no props and opens on the brand scope (outletId null).
//  - Environment defaults to sandbox (never production) when untouched.
//  - A stored row is the one for the chosen scope in GET /api/org/integrations.
//  - The credential inputs stay empty after a save (stored values are never
//    shown), and a failed save never repeats a typed secret on screen.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  gatewayCredentialIssues,
  GATEWAY_CREDENTIAL_SPECS,
  integrationConnectionTestSchema,
  upsertIntegrationInputSchema,
} from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import { messagesId } from "@starter/shared/i18n";
import { paymentDuitkuMessages as copy } from "../../../packages/shared/src/i18n/messages/ws05-duitku-credentials";

// ---------------------------------------------------------------- harness

type Props = Record<string, unknown>;
type Rec = { type: unknown; props: Props };
type Entry = {
  options: {
    queryKey: unknown[];
    queryFn: (ctx: unknown) => Promise<unknown>;
    select?: (data: unknown) => unknown;
    enabled?: boolean;
  };
  status: "pending" | "success" | "error";
  data?: unknown;
  error?: unknown;
  fetching: boolean;
};

const h = vi.hoisted(() => ({
  slots: new Map<string, unknown>(),
  records: [] as Array<{ type: unknown; props: Record<string, unknown> }>,
  cache: new Map<string, unknown>(),
  dirty: false,
  toasts: [] as Array<{ title?: string; description?: string; tone?: string }>,
  slot: (() => "") as (init: () => unknown) => string,
  record(type: unknown, props: Record<string, unknown> | null) {
    if (!props) return;
    if (
      typeof type === "string" ||
      props.onValueChange !== undefined ||
      props.onCheckedChange !== undefined
    )
      h.records.push({ type, props });
  },
  wrapJsx(real: Record<string, unknown>, name: string): unknown {
    const fn = real[name] as
      | ((
          type: unknown,
          props: Record<string, unknown>,
          ...r: unknown[]
        ) => unknown)
      | undefined;
    return fn
      ? (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
          h.record(type, props);
          return fn(type, props, ...rest);
        }
      : undefined;
  },
  api: (async () => undefined) as (
    path: string,
    init?: Record<string, unknown>,
  ) => Promise<unknown>,
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  // Persistent hook state keyed by React's tree-position useId, so it survives
  // repeated renderToString passes even when siblings appear or disappear.
  h.slot = (init) => {
    const key = react.useId();
    if (!h.slots.has(key)) h.slots.set(key, init());
    return key;
  };
  const overrides = {
    useState: (initial: unknown) => {
      const key = h.slot(() =>
        typeof initial === "function" ? (initial as () => unknown)() : initial,
      );
      return [
        h.slots.get(key),
        (next: unknown) => {
          const current = h.slots.get(key);
          h.slots.set(
            key,
            typeof next === "function"
              ? (next as (value: unknown) => unknown)(current)
              : next,
          );
          h.dirty = true;
        },
      ];
    },
    useReducer: (
      reducer: (state: unknown, action: unknown) => unknown,
      initial: unknown,
      init?: (value: unknown) => unknown,
    ) => {
      const key = h.slot(() => (init ? init(initial) : initial));
      return [
        h.slots.get(key),
        (action: unknown) => {
          h.slots.set(key, reducer(h.slots.get(key), action));
          h.dirty = true;
        },
      ];
    },
    useRef: (initial: unknown) =>
      h.slots.get(h.slot(() => ({ current: initial }))),
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useInsertionEffect: () => undefined,
    useImperativeHandle: () => undefined,
  };
  return { ...react, ...overrides, default: { ...react, ...overrides } };
});

vi.mock("react/jsx-runtime", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    jsx: h.wrapJsx(real, "jsx"),
    jsxs: h.wrapJsx(real, "jsxs"),
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const real = await original<Record<string, unknown>>();
  return { ...real, jsxDEV: h.wrapJsx(real, "jsxDEV") };
});

vi.mock("@tanstack/react-query", async (original) => {
  const rq = await original<typeof import("@tanstack/react-query")>();
  const entries = h.cache as Map<string, Entry>;
  const run = async (entry: Entry) => {
    entry.fetching = true;
    try {
      entry.data = await entry.options.queryFn({
        queryKey: entry.options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      });
      entry.status = "success";
      entry.error = null;
    } catch (error) {
      entry.error = error;
      entry.status = "error";
    }
    entry.fetching = false;
    h.dirty = true;
  };
  const useQuery = (options: Entry["options"]) => {
    const key = JSON.stringify(options.queryKey);
    let entry = entries.get(key);
    if (!entry) {
      entry = { options, status: "pending", fetching: false };
      entries.set(key, entry);
      if (options.enabled !== false) void run(entry);
    }
    entry.options = options;
    const snapshot = entry;
    return {
      status: snapshot.status,
      data:
        snapshot.status === "success" && options.select
          ? options.select(snapshot.data)
          : snapshot.data,
      error: snapshot.error ?? null,
      isPending: snapshot.status === "pending",
      isLoading: snapshot.status === "pending",
      isSuccess: snapshot.status === "success",
      isError: snapshot.status === "error",
      isFetching: snapshot.fetching,
      isRefetching: false,
      dataUpdatedAt: 0,
      refetch: async () => {
        await run(snapshot);
        return snapshot;
      },
    };
  };
  const useMutation = (options: {
    mutationFn: (variables: unknown) => Promise<unknown>;
    onSuccess?: (...a: unknown[]) => unknown;
    onError?: (...a: unknown[]) => unknown;
    onSettled?: (...a: unknown[]) => unknown;
  }) => {
    const state = h.slots.get(
      h.slot(() => ({
        status: "idle",
        data: undefined,
        error: null,
        variables: undefined,
      })),
    ) as {
      status: string;
      data: unknown;
      error: unknown;
      variables: unknown;
    };
    const execute = async (
      variables: unknown,
      callbacks?: Record<string, (...a: unknown[]) => unknown>,
    ) => {
      state.status = "pending";
      state.error = null;
      state.variables = variables;
      h.dirty = true;
      try {
        const data = await options.mutationFn(variables);
        state.status = "success";
        state.data = data;
        await options.onSuccess?.(data, variables, undefined);
        callbacks?.onSuccess?.(data, variables, undefined);
        return data;
      } catch (error) {
        state.status = "error";
        state.error = error;
        await options.onError?.(error, variables, undefined);
        callbacks?.onError?.(error, variables, undefined);
        throw error;
      } finally {
        h.dirty = true;
        options.onSettled?.();
        callbacks?.onSettled?.();
      }
    };
    return {
      status: state.status,
      data: state.data,
      error: state.error,
      variables: state.variables,
      isIdle: state.status === "idle",
      isPending: state.status === "pending",
      isSuccess: state.status === "success",
      isError: state.status === "error",
      mutate: (
        variables: unknown,
        callbacks?: Record<string, (...a: unknown[]) => unknown>,
      ) => void execute(variables, callbacks).catch(() => undefined),
      mutateAsync: execute,
      reset: () => {
        state.status = "idle";
        state.data = undefined;
        state.error = null;
      },
    };
  };
  const useQueryClient = () => {
    const known = {
      setQueryData: (key: unknown[], updater: unknown) => {
        const k = JSON.stringify(key);
        const previous = entries.get(k);
        const next =
          typeof updater === "function"
            ? (updater as (value: unknown) => unknown)(previous?.data)
            : updater;
        if (next !== undefined && previous) {
          previous.data = next;
          previous.status = "success";
        }
        return next;
      },
      getQueryData: (key: unknown[]) => entries.get(JSON.stringify(key))?.data,
      invalidateQueries: async (filter?: { queryKey?: unknown[] }) => {
        const head = filter?.queryKey?.[0];
        await Promise.all(
          [...entries.values()]
            .filter(
              (entry) =>
                head === undefined || entry.options.queryKey[0] === head,
            )
            .map((entry) => run(entry)),
        );
      },
    };
    return new Proxy(known, {
      get: (target, name) =>
        name in target
          ? target[name as keyof typeof target]
          : async () => undefined,
    });
  };
  return { ...rq, useQuery, useMutation, useQueryClient };
});

vi.mock("@/lib/api/client", async () => {
  const { ApiError: Err } = await import("@/lib/api/errors");
  return {
    ApiError: Err,
    apiFetch: (path: string, init?: Record<string, unknown>) =>
      h.api(path, init),
  };
});
vi.mock("@/components/ui/toast", () => ({
  useToast: () => (toast: { title?: string }) => h.toasts.push(toast),
}));
vi.mock("@/lib/use-online", () => ({ useOnline: () => true }));

import { DuitkuCredentialsPanel } from "@/features/ws05-payment-admin/components/duitku-credentials-panel";

// ---------------------------------------------------------------- fake API

const ID = {
  tenant: "11111111-1111-4111-8111-111111111111",
  brand: "22222222-2222-4222-8222-222222222222",
  outlet: "33333333-3333-4333-8333-333333333333",
  legal: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  brandRow: "66666666-6666-4666-8666-666666666666",
  outletRow: "77777777-7777-4777-8777-777777777777",
  doitRow: "88888888-8888-4888-8888-888888888888",
};
const API_KEY = "sk-live-Zq81-NOT-A-REAL-KEY";
const MERCHANT = "D88231";
const SECRET_REF = "sec_AAAAAAAAAAAAAAAAAAAAAA";
const NOW = "2026-11-16T10:00:00.000Z";

type Call = { method: string; path: string; body: unknown };
const api = {
  calls: [] as Call[],
  rows: [] as Record<string, unknown>[],
  outlets: [] as Record<string, unknown>[],
  listError: null as unknown,
  putError: null as unknown,
  testError: null as unknown,
  testResult: null as Record<string, unknown> | null,
  testGate: null as Promise<void> | null,
  statusError: null as unknown,
  outletsError: null as unknown,
  outletsGate: null as Promise<void> | null,
};
const LATER = "2026-11-16T10:05:00.000Z";

function row(over: Record<string, unknown> = {}) {
  return {
    id: ID.brandRow,
    tenantId: ID.tenant,
    outletId: null,
    provider: "duitku",
    config: {
      environment: "sandbox",
      notificationEmail: "ops@kopi.example",
      vaName: "KOPI LEGEND",
    },
    credentials: {
      secretRef: SECRET_REF,
      fields: ["apiKey", "merchantCode"],
      setAt: NOW,
      setBy: ID.user,
    },
    status: "draft",
    lastCheckedAt: null,
    lastErrorCode: null,
    updatedAt: NOW,
    ...over,
  };
}

function outlet() {
  const day = { opens: "08:00", closes: "22:00" };
  return {
    id: ID.outlet,
    tenantId: ID.tenant,
    brandId: ID.brand,
    legalEntityId: ID.legal,
    code: "JKT-01",
    name: "Outlet Senayan",
    address: "Jl. Asia Afrika 1",
    regionId: null,
    geofence: null,
    timeZone: "Asia/Jakarta",
    businessDayCutoff: "04:00",
    openingHours: Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, day]),
    ),
    edgeNodeId: null,
    status: "active",
    createdAt: NOW,
  };
}

h.api = async (path, init = {}) => {
  const method = String(init.method ?? "GET");
  api.calls.push({ method, path, body: init.body });
  if (method === "GET" && path === "/api/org/integrations") {
    if (api.listError) throw api.listError;
    return { data: api.rows };
  }
  if (method === "GET" && path === "/api/org/outlets") {
    if (api.outletsGate) await api.outletsGate;
    if (api.outletsError) throw api.outletsError;
    return { data: api.outlets, meta: { limit: 100, nextCursor: null } };
  }
  if (method === "GET" && path === "/api/org/brands") return { data: [] };
  if (method === "PUT" && path === "/api/org/integrations") {
    if (api.putError) throw api.putError;
    const body = init.body as {
      outletId: string | null;
      provider: string;
      config: Record<string, unknown>;
      credentials?: Record<string, string>;
    };
    const existing = api.rows.find(
      (r) => r.outletId === body.outletId && r.provider === body.provider,
    );
    const saved = row({
      id: existing?.id ?? ID.outletRow,
      outletId: body.outletId,
      config: body.config,
      credentials: body.credentials
        ? {
            secretRef: SECRET_REF,
            fields: Object.keys(body.credentials).sort(),
            setAt: NOW,
            setBy: ID.user,
          }
        : (existing?.credentials ?? null),
      status: existing?.status ?? "draft",
    });
    api.rows = [...api.rows.filter((r) => r !== existing), saved];
    return { data: saved };
  }
  const test = /^\/api\/org\/integrations\/([^/]+)\/test$/.exec(path);
  if (method === "POST" && test) {
    if (api.testGate) await api.testGate;
    if (api.testError) throw api.testError;
    // The API stamps the row on every test, which bumps its updatedAt.
    api.rows = api.rows.map((r) =>
      r.id === test[1]
        ? {
            ...r,
            updatedAt: LATER,
            lastCheckedAt: LATER,
            lastErrorCode: api.testResult?.errorCode ?? null,
          }
        : r,
    );
    return {
      data: api.testResult ?? {
        ok: true,
        checkedAt: NOW,
        errorCode: null,
        methods: [],
      },
    };
  }
  const status = /^\/api\/org\/integrations\/([^/]+)\/status$/.exec(path);
  if (method === "POST" && status) {
    if (api.statusError) throw api.statusError;
    const next = (init.body as { status: string }).status;
    const found = api.rows.find((r) => r.id === status[1]);
    if (!found) throw new ApiError(404, "NOT_FOUND", "no row");
    const saved = { ...found, status: next, updatedAt: LATER };
    api.rows = api.rows.map((r) => (r === found ? saved : r));
    return { data: saved };
  }
  throw new ApiError(404, "NOT_FOUND", "unknown test route");
};

// ---------------------------------------------------------- view helpers

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
const textOf = (html: string) =>
  decode(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key]));
const flatten = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  const props = (node as { props?: Props }).props;
  return props ? flatten(props.children) : "";
};

let html = "";
function render() {
  for (let pass = 0; pass < 4; pass++) {
    h.dirty = false;
    h.records = [];
    html = renderToString(createElement(DuitkuCredentialsPanel));
    if (!h.dirty) break;
  }
}
async function settle() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    render();
  }
}
async function mount() {
  render();
  await settle();
}
const text = () =>
  [
    textOf(html),
    ...h.toasts.map((t) => `${t.title ?? ""} ${t.description ?? ""}`),
  ]
    .join(" ")
    .trim();

function buttons() {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({
      text: textOf(m[2]),
      disabled: /\sdisabled(=|\s|>|$)|aria-disabled="true"/.test(m[1] ?? ""),
    }),
  );
}
function buttonState(label: string): "absent" | "disabled" | "enabled" {
  const found = buttons().find((b) => b.text.includes(label));
  return !found ? "absent" : found.disabled ? "disabled" : "enabled";
}
async function click(label: string) {
  expect(buttonState(label), `button "${label}"`).toBe("enabled");
  const rec = h.records.find(
    (r) =>
      r.type === "button" &&
      flatten(r.props.children).includes(label) &&
      typeof r.props.onClick === "function",
  );
  expect(rec, `click handler of "${label}"`).toBeDefined();
  (rec!.props.onClick as (e: unknown) => void)({
    preventDefault() {},
    stopPropagation() {},
    currentTarget: {},
    target: {},
  });
  await settle();
}
async function submit() {
  const form = h.records.find(
    (r) => r.type === "form" && typeof r.props.onSubmit === "function",
  );
  expect(form, "form with a submit handler").toBeDefined();
  (form!.props.onSubmit as (e: unknown) => void)({
    preventDefault() {},
    stopPropagation() {},
    currentTarget: {},
    target: {},
  });
  await settle();
}

type Field = "merchantCode" | "apiKey" | "notificationEmail" | "vaName";
/** The input a user sees under the label of this field. */
function input(field: Field): Rec {
  const label = copy.fields[field];
  const ids = [
    ...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g),
  ]
    .filter((m) =>
      textOf(m[2] ?? "")
        .toLowerCase()
        .includes(label.toLowerCase()),
    )
    .map((m) => m[1]);
  const rec = h.records.find(
    (r) =>
      (r.type === "input" || r.type === "textarea") &&
      ((typeof r.props.id === "string" && ids.includes(r.props.id)) ||
        String(r.props["aria-label"] ?? "")
          .toLowerCase()
          .includes(label.toLowerCase())),
  );
  expect(rec, `input labelled "${label}"`).toBeDefined();
  return rec!;
}
const hasInput = (field: Field) => {
  try {
    input(field);
    return true;
  } catch {
    return false;
  }
};
const valueOf = (field: Field) => String(input(field).props.value ?? "");
async function type(field: Field, value: string) {
  const rec = input(field);
  (rec.props.onChange as (e: unknown) => void)({
    target: { value, name: rec.props.name, id: rec.props.id },
    currentTarget: { value },
    persist() {},
  });
  await settle();
}
async function typeAll(values: Partial<Record<Field, string>>) {
  for (const [field, value] of Object.entries(values))
    await type(field as Field, value);
}
async function blur(field: Field) {
  const rec = input(field);
  (rec.props.onBlur as (e: unknown) => void)({
    target: { value: rec.props.value, name: rec.props.name },
    currentTarget: {},
  });
  await settle();
}
async function chooseEnvironment(value: "sandbox" | "production") {
  const select = h.records.find(
    // Value is "" until chosen. Not the scope control ("brand"/"outlet") and
    // not the outlet picker (an outlet id).
    (r) =>
      typeof r.props.onValueChange === "function" &&
      ["", "sandbox", "production"].includes(String(r.props.value ?? "")),
  );
  expect(select, "environment select").toBeDefined();
  (select!.props.onValueChange as (v: string) => void)(value);
  await settle();
}
/** Environment is a required choice; pick sandbox, then type the fields. */
async function fillValid(values: Partial<Record<Field, string>> = validNew) {
  await chooseEnvironment("sandbox");
  await typeAll(values);
}
async function chooseScope(value: "brand" | "outlet") {
  const control = h.records.find(
    (r) =>
      (r.props.value === "brand" || r.props.value === "outlet") &&
      typeof r.props.onValueChange === "function",
  );
  expect(control, "scope control").toBeDefined();
  (control!.props.onValueChange as (v: string) => void)(value);
  await settle();
}

const puts = () => api.calls.filter((c) => c.method === "PUT");
const tests = () =>
  api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/test"));
const statusPosts = () =>
  api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/status"));
const validNew = {
  merchantCode: MERCHANT,
  apiKey: API_KEY,
  notificationEmail: "ops@kopi.example",
  vaName: "KOPI LEGEND",
};

beforeEach(() => {
  h.slots.clear();
  h.cache.clear();
  h.records = [];
  h.toasts = [];
  html = "";
  Object.assign(api, {
    calls: [],
    rows: [],
    outlets: [],
    listError: null,
    putError: null,
    testError: null,
    testResult: null,
    testGate: null,
    statusError: null,
    outletsError: null,
    outletsGate: null,
  });
});

// ------------------------------------------------------------------ tests

describe("legend-vntqt: Duitku credentials form (D15)", () => {
  test("empty state: not configured, blank form, test blocked until saved", async () => {
    await mount();

    const page = text();
    expect(page).toContain(copy.title);
    expect(page).toContain(copy.status.notConfigured);
    for (const field of [
      "merchantCode",
      "apiKey",
      "notificationEmail",
      "vaName",
    ] as const) {
      expect(hasInput(field), field).toBe(true);
      expect(valueOf(field), field).toBe("");
    }
    expect(page).toContain(copy.test.needSave);
    expect(buttonState(copy.test.action)).not.toBe("enabled");
    expect(buttonState(copy.save)).toBe("enabled");
  });

  test("load failure shows an error with retry instead of a blank form", async () => {
    api.listError = new ApiError(500, "INTERNAL_ERROR", "boom");
    await mount();

    expect(text()).toContain(copy.loadErrorTitle);
    expect(text()).toContain(copy.loadErrorHint);
    expect(hasInput("apiKey")).toBe(false);
  });

  test("stored credentials are shown as status only, never as values", async () => {
    api.rows = [
      row({ status: "active", lastCheckedAt: NOW, lastErrorCode: null }),
    ];
    await mount();

    const page = text();
    expect(page).toContain(copy.status.testedOk);
    expect(page).toContain(copy.credentials.storedHint);
    // Neither the opaque reference nor any secret-looking value is on screen.
    expect(html).not.toContain(SECRET_REF);
    expect(html).not.toContain(API_KEY);
    expect(html).not.toContain(MERCHANT);
    // Both credential inputs are blank (merchantCode is not echoed either).
    expect(valueOf("merchantCode")).toBe("");
    expect(valueOf("apiKey")).toBe("");
    expect(String(input("apiKey").props.type)).toBe("password");
    // Non-secret settings are editable and prefilled.
    expect(valueOf("notificationEmail")).toBe("ops@kopi.example");
    expect(valueOf("vaName")).toBe("KOPI LEGEND");
  });

  test("status wording follows the stored row: untested, tested ok, tested failed", async () => {
    api.rows = [row()];
    await mount();
    expect(text()).toContain(copy.status.saved);

    h.slots.clear();
    h.cache.clear();
    api.rows = [
      row({ lastCheckedAt: NOW, lastErrorCode: "DUITKU_AUTH_FAILED" }),
    ];
    await mount();
    expect(text()).toContain(copy.status.testedError);
    expect(text()).toContain(
      fill(copy.status.lastError, { code: "DUITKU_AUTH_FAILED" }),
    );
  });

  test("first save sends the Duitku contract: both credentials, environment, email, vaName", async () => {
    await mount();
    await typeAll(validNew);
    await chooseEnvironment("production");
    await submit();

    expect(puts()).toHaveLength(1);
    const body = puts()[0]!.body as {
      outletId: string | null;
      provider: string;
      config: Record<string, unknown>;
      credentials: Record<string, string>;
    };
    expect(puts()[0]!.path).toBe("/api/org/integrations");
    expect(upsertIntegrationInputSchema.safeParse(body).success).toBe(true);
    expect(body.provider).toBe("duitku");
    expect(body.outletId).toBeNull();
    expect(body.config).toEqual({
      environment: "production",
      notificationEmail: "ops@kopi.example",
      vaName: "KOPI LEGEND",
    });
    expect(Object.keys(body.credentials).sort()).toEqual(
      [...GATEWAY_CREDENTIAL_SPECS.duitku.credentials].sort(),
    );
    expect(body.credentials).toEqual({
      merchantCode: MERCHANT,
      apiKey: API_KEY,
    });
    expect(
      gatewayCredentialIssues("duitku", body.config, body.credentials),
    ).toEqual([]);
  });

  test("environment is never production unless the user picks it", async () => {
    // Spec: environment is required. Either the form starts on sandbox or it
    // asks for a choice; it must not silently send production.
    await mount();
    await typeAll(validNew);
    await submit();

    const sent = puts()[0]?.body as
      { config: { environment: string } } | undefined;
    if (sent) expect(sent.config.environment).toBe("sandbox");
    else expect(text()).toContain(copy.errors.required);
  });

  test("after a successful save the typed secrets are gone from the screen", async () => {
    await mount();
    await fillValid();
    await submit();

    expect(puts()).toHaveLength(1);
    expect(text()).toContain(copy.saved);
    expect(html).not.toContain(API_KEY);
    expect(html).not.toContain(MERCHANT);
    expect(JSON.stringify(h.toasts)).not.toContain(API_KEY);
    expect(valueOf("apiKey")).toBe("");
    expect(valueOf("merchantCode")).toBe("");
    // The saved row now reads as stored, without any value.
    expect(text()).toContain(copy.status.saved);
    expect(html).not.toContain(SECRET_REF);
  });

  test("a blank vaName is omitted, a 20 character vaName is accepted", async () => {
    await mount();
    await fillValid({ ...validNew, vaName: "" });
    await submit();
    const first = puts()[0]!.body as { config: { vaName?: unknown } };
    expect([undefined, null, ""]).toContain(first.config.vaName);

    h.slots.clear();
    h.cache.clear();
    api.rows = [];
    api.calls = [];
    await mount();
    await fillValid({ ...validNew, vaName: "A".repeat(20) });
    await submit();
    const second = puts()[0]!.body as { config: { vaName?: unknown } };
    expect(second.config.vaName).toBe("A".repeat(20));
  });

  test("invalid email is rejected on the field and nothing is sent", async () => {
    await mount();
    await fillValid({ ...validNew, notificationEmail: "bukan-email" });
    await submit();

    expect(puts()).toHaveLength(0);
    expect(text()).toContain(copy.errors.email);
    expect(text()).not.toContain(copy.saved);
  });

  test("missing email is rejected as required", async () => {
    await mount();
    await fillValid({ ...validNew, notificationEmail: "" });
    await submit();

    expect(puts()).toHaveLength(0);
    expect(text()).toContain(copy.errors.required);
  });

  test("vaName longer than 20 characters is rejected and nothing is sent", async () => {
    await mount();
    await fillValid({ ...validNew, vaName: "A".repeat(21) });
    await submit();

    expect(puts()).toHaveLength(0);
    expect(text()).toContain(copy.errors.vaNameLong);
  });

  test.each(["merchantCode", "apiKey"] as const)(
    "a first save without %s is rejected and nothing is sent",
    async (missing) => {
      await mount();
      await fillValid({ ...validNew, [missing]: "" });
      await submit();

      expect(puts()).toHaveLength(0);
      expect(text()).toContain(copy.errors.required);
    },
  );

  test("with stored credentials, saving settings only keeps the secret untouched", async () => {
    api.rows = [row({ status: "active", lastCheckedAt: NOW })];
    await mount();
    await type("notificationEmail", "finance@kopi.example");
    await submit();

    expect(puts()).toHaveLength(1);
    const body = puts()[0]!.body as {
      config: Record<string, unknown>;
      credentials?: unknown;
    };
    expect(body.credentials).toBeUndefined();
    expect(body.config.notificationEmail).toBe("finance@kopi.example");
  });

  test("rotating needs both credentials: only one typed is refused", async () => {
    api.rows = [row({ status: "active" })];
    await mount();
    await type("apiKey", API_KEY);
    await submit();

    expect(puts()).toHaveLength(0);
    expect(text()).toContain(copy.errors.credentialsIncomplete);

    h.slots.clear();
    h.cache.clear();
    await mount();
    await typeAll({ merchantCode: MERCHANT, apiKey: API_KEY });
    await submit();
    const body = puts()[0]!.body as { credentials: Record<string, string> };
    expect(body.credentials).toEqual({
      merchantCode: MERCHANT,
      apiKey: API_KEY,
    });
  });

  test("a server validation error shows a generic message and never echoes secrets", async () => {
    api.putError = new ApiError(
      422,
      "VALIDATION_ERROR",
      `apiKey ${API_KEY} merchantCode ${MERCHANT} rejected`,
    );
    await mount();
    await fillValid();
    await submit();

    expect(puts()).toHaveLength(1);
    expect(text()).toContain(copy.errors.invalid);
    expect(html).not.toContain(API_KEY);
    expect(html).not.toContain(MERCHANT);
    expect(JSON.stringify(h.toasts)).not.toContain(API_KEY);
    expect(text()).not.toContain(copy.saved);
  });

  test.each([
    ["FORBIDDEN", 403, copy.errors.forbidden],
    ["NETWORK_ERROR", 0, copy.errors.offline],
  ] as const)("save failure %s is explained", async (code, status, message) => {
    api.putError = new ApiError(status, code, "internal detail");
    await mount();
    await fillValid();
    await submit();

    expect(text()).toContain(message);
    expect(text()).not.toContain("internal detail");
    expect(text()).not.toContain(copy.saved);
  });

  test("outlet scope saves for that outlet and says when brand credentials apply", async () => {
    api.outlets = [outlet()];
    api.rows = [row({ status: "active", lastCheckedAt: NOW })];
    await mount();
    expect(text()).toContain(copy.scopeBrand);
    expect(text()).toContain(copy.scopeOutlet);

    await chooseScope("outlet");
    expect(text()).toContain(copy.inherited);

    await fillValid({
      ...validNew,
      notificationEmail: "senayan@kopi.example",
    });
    await submit();

    expect(puts()).toHaveLength(1);
    expect((puts()[0]!.body as { outletId: string }).outletId).toBe(ID.outlet);
  });
});

describe("legend-vntqt: Duitku connection test (D16)", () => {
  test("the test button posts to the stored row without a body or credentials", async () => {
    api.rows = [
      row({ id: ID.doitRow, provider: "doit", config: {}, status: "active" }),
      row({
        id: ID.outletRow,
        outletId: ID.outlet,
        status: "draft",
      }),
      row({ id: ID.brandRow, status: "draft" }),
    ];
    await mount();
    await click(copy.test.action);

    expect(tests()).toHaveLength(1);
    expect(tests()[0]!.path).toBe(`/api/org/integrations/${ID.brandRow}/test`);
    expect(tests()[0]!.body).toBeUndefined();
    expect(puts()).toHaveLength(0);
  });

  test("a successful test shows ok and the methods Duitku returned", async () => {
    api.rows = [row()];
    api.testResult = {
      ok: true,
      checkedAt: NOW,
      errorCode: null,
      methods: [
        { method: "va", enabled: true, channelCount: 3 },
        { method: "qris", enabled: false, channelCount: 0 },
      ],
    };
    expect(
      integrationConnectionTestSchema.safeParse(api.testResult).success,
    ).toBe(true);
    await mount();
    await click(copy.test.action);

    const page = text();
    expect(page).toContain(copy.test.ok);
    expect(page).not.toContain(copy.test.failed);
    expect(page).toContain(copy.test.methodsTitle);
    expect(page).toContain(fill(copy.test.channelCount, { count: 3 }));
  });

  test("a failed test shows the error code and no success message", async () => {
    api.rows = [row()];
    api.testResult = {
      ok: false,
      checkedAt: NOW,
      errorCode: "DUITKU_AUTH_FAILED",
      methods: [],
    };
    await mount();
    await click(copy.test.action);

    const page = text();
    expect(page).toContain(copy.test.failed);
    expect(page).toContain(
      fill(copy.test.errorCode, { code: "DUITKU_AUTH_FAILED" }),
    );
    expect(page).not.toContain(copy.test.ok);
    expect(html).not.toContain(SECRET_REF);
  });

  test("while testing, the button is blocked and progress is shown", async () => {
    api.rows = [row()];
    let release: () => void = () => {};
    api.testGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();
    await click(copy.test.action);

    expect(text()).toContain(copy.test.running);
    expect(buttonState(copy.test.action)).not.toBe("enabled");
    expect(tests()).toHaveLength(1);

    release();
    await settle();
    expect(text()).toContain(copy.test.ok);
    expect(text()).not.toContain(copy.test.running);
  });

  test("a request failure is explained and is not shown as a connection result", async () => {
    api.rows = [row()];
    api.testError = new ApiError(422, "NOT_SUPPORTED", "no adapter");
    await mount();
    await click(copy.test.action);

    expect(text()).toContain(copy.errors.notSupported);
    expect(text()).not.toContain(copy.test.ok);
    expect(text()).not.toContain("no adapter");
  });

  test("no stored credentials: the test cannot be started", async () => {
    api.rows = [
      row({ id: ID.doitRow, provider: "doit", config: {}, status: "active" }),
    ];
    await mount();

    expect(text()).toContain(copy.test.needSave);
    expect(buttonState(copy.test.action)).not.toBe("enabled");
    expect(tests()).toHaveLength(0);
  });
});

describe("legend-vntqt: Duitku panel review fixes", () => {
  test("a connection test keeps the form: unsaved input and the result stay", async () => {
    api.rows = [row({ status: "active" })];
    api.testResult = {
      ok: true,
      checkedAt: LATER,
      errorCode: null,
      methods: [],
    };
    await mount();
    await type("notificationEmail", "finance@kopi.example");
    await click(copy.test.action);

    expect(tests()).toHaveLength(1);
    // The refetched row has a newer updatedAt; the form must not remount.
    expect(valueOf("notificationEmail")).toBe("finance@kopi.example");
    expect(text()).toContain(copy.test.ok);
    expect(text()).toContain(copy.status.testedOk);
  });

  test("a failed test explains the cause and the next step", async () => {
    api.rows = [row()];
    api.testResult = {
      ok: false,
      checkedAt: NOW,
      errorCode: "GATEWAY_AUTH_FAILED",
      methods: [],
    };
    await mount();
    await click(copy.test.action);

    expect(text()).toContain(copy.test.cause.authFailed);
    expect(text()).toContain(copy.test.advice.authFailed);
    expect(text()).toContain(
      fill(copy.test.errorCode, { code: "GATEWAY_AUTH_FAILED" }),
    );
  });

  test("an unknown error code still gets a plain explanation", async () => {
    api.rows = [row()];
    api.testResult = {
      ok: false,
      checkedAt: NOW,
      errorCode: "SOMETHING_NEW",
      methods: [],
    };
    await mount();
    await click(copy.test.action);

    expect(text()).toContain(copy.test.cause.unknown);
    expect(text()).toContain(copy.test.advice.unknown);
  });

  test("test methods use the catalog label, unknown codes stay as returned", async () => {
    api.rows = [row()];
    api.testResult = {
      ok: true,
      checkedAt: NOW,
      errorCode: null,
      methods: [
        { method: "va", enabled: true, channelCount: 3 },
        { method: "zz_new", enabled: false, channelCount: 0 },
      ],
    };
    await mount();
    await click(copy.test.action);

    expect(text()).toContain(messagesId.paymentAdmin.method.va);
    expect(text()).toContain("zz_new");
  });

  test("outlets still loading: outlet scope is disabled and says so", async () => {
    api.outlets = [outlet()];
    let release: () => void = () => {};
    api.outletsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();

    expect(text()).toContain(copy.outletsLoading);
    expect(text()).not.toContain(copy.noOutlets);
    expect(html).toMatch(/<fieldset[^>]*\sdisabled=""/);
    await chooseScope("outlet");
    expect(text()).not.toContain(copy.inherited);
    expect(hasInput("merchantCode")).toBe(true);

    release();
    await settle();
    expect(html).not.toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(text()).not.toContain(copy.outletsLoading);
  });

  test("outlets failed to load: error with retry, not 'no outlets'", async () => {
    api.outletsError = new ApiError(500, "INTERNAL_ERROR", "boom");
    await mount();

    expect(text()).toContain(copy.outletsError);
    expect(text()).toContain(copy.outletsRetry);
    expect(text()).not.toContain(copy.noOutlets);
    expect(html).toMatch(/<fieldset[^>]*\sdisabled=""/);
    await chooseScope("outlet");
    expect(text()).not.toContain(copy.inherited);
  });

  test("no outlets: says so and keeps the brand form usable", async () => {
    await mount();

    expect(text()).toContain(copy.noOutlets);
    expect(text()).not.toContain(copy.outletsError);
    expect(html).toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(hasInput("merchantCode")).toBe(true);
  });

  test("a failed save tells the user the secrets were cleared", async () => {
    api.putError = new ApiError(500, "INTERNAL_ERROR", "boom");
    await mount();
    await fillValid();
    await submit();

    expect(puts()).toHaveLength(1);
    expect(text()).toContain(copy.errors.generic);
    expect(text()).toContain(copy.saveClearedNotice);
    expect(valueOf("merchantCode")).toBe("");
    expect(valueOf("apiKey")).toBe("");
    expect(html).not.toContain(API_KEY);
    // Settings the user typed are kept.
    expect(valueOf("notificationEmail")).toBe(validNew.notificationEmail);
  });

  test("a save that never sent secrets does not claim they were cleared", async () => {
    api.rows = [row({ status: "active" })];
    api.putError = new ApiError(500, "INTERNAL_ERROR", "boom");
    await mount();
    await type("notificationEmail", "finance@kopi.example");
    await submit();

    expect(text()).toContain(copy.errors.generic);
    expect(text()).not.toContain(copy.saveClearedNotice);
  });

  test("a field is validated when the user leaves it", async () => {
    await mount();
    await type("notificationEmail", "bukan-email");
    expect(text()).not.toContain(copy.errors.email);
    await blur("notificationEmail");

    expect(text()).toContain(copy.errors.email);
    expect(puts()).toHaveLength(0);
    // Fixing it clears the message without another blur.
    await type("notificationEmail", "ops@kopi.example");
    expect(text()).not.toContain(copy.errors.email);
  });

  test("the loading state is announced and marked busy", async () => {
    render();

    expect(html).toContain('aria-busy="true"');
    expect(text()).toContain(copy.loading);
    expect(hasInput("apiKey")).toBe(false);
  });

  test("the provider name comes from the catalog", async () => {
    await mount();
    expect(html).toContain(`translate="no"`);
    expect(text()).toContain(copy.providerName);
  });

  test("a new row is told it will be a draft and where to activate it", async () => {
    await mount();

    expect(text()).toContain(copy.activation.newHint);
    expect(html).toContain('href="/kelola/pengaturan/integrasi"');
  });

  test("a draft row points to integration settings; an active row does not", async () => {
    api.rows = [row({ status: "draft" })];
    await mount();
    expect(text()).toContain(copy.activation.pendingHint);

    h.slots.clear();
    h.cache.clear();
    api.rows = [row({ status: "active" })];
    await mount();
    expect(text()).not.toContain(copy.activation.pendingHint);
    expect(text()).not.toContain(copy.activation.newHint);
  });
});

describe("legend-mp44v: Duitku activation from the credentials screen", () => {
  const tested = (over: Record<string, unknown> = {}) =>
    row({ lastCheckedAt: LATER, lastErrorCode: null, ...over });

  test("draft with a successful test: Aktifkan is enabled", async () => {
    api.rows = [tested()];
    await mount();

    expect(buttonState(copy.activation.action)).toBe("enabled");
    expect(text()).toContain(copy.activation.readyHint);
  });

  test("draft never tested: disabled with the reason", async () => {
    api.rows = [row()];
    await mount();

    expect(buttonState(copy.activation.action)).toBe("disabled");
    expect(text()).toContain(copy.activation.needTest);
    expect(statusPosts()).toHaveLength(0);
  });

  test("draft with a failed test: disabled with the reason", async () => {
    api.rows = [tested({ lastErrorCode: "DUITKU_AUTH_FAILED" })];
    await mount();

    expect(buttonState(copy.activation.action)).toBe("disabled");
    expect(text()).toContain(copy.activation.testFailed);
    expect(statusPosts()).toHaveLength(0);
  });

  test("a disabled row has no Aktifkan button", async () => {
    api.rows = [tested({ status: "disabled" })];
    await mount();

    expect(buttonState(copy.activation.action)).toBe("absent");
  });

  test("click posts the active status, then shows Aktif and drops the draft hint", async () => {
    api.rows = [tested()];
    await mount();
    expect(text()).toContain(copy.activation.pendingHint);
    await click(copy.activation.action);

    expect(statusPosts()).toHaveLength(1);
    expect(statusPosts()[0]!.path).toBe(
      `/api/org/integrations/${ID.brandRow}/status`,
    );
    expect(statusPosts()[0]!.body).toEqual({ status: "active" });
    expect(text()).toContain(copy.activation.activeLabel);
    expect(text()).toContain(copy.activation.done);
    expect(text()).not.toContain(copy.activation.pendingHint);
    expect(buttonState(copy.activation.action)).toBe("absent");
  });

  test("INVALID_TRANSITION is explained without the server message", async () => {
    api.rows = [tested()];
    api.statusError = new ApiError(409, "INVALID_TRANSITION", "raw-server-msg");
    await mount();
    await click(copy.activation.action);

    expect(html).toContain('role="alert"');
    expect(text()).toContain(copy.errors.invalidTransition);
    expect(text()).not.toContain("raw-server-msg");
    expect(text()).not.toMatch(
      new RegExp(`(?<![\\w])${copy.activation.activeLabel}(?![\\w])`),
    );
  });

  test("a provider Super Admin has not enabled is explained", async () => {
    api.rows = [tested()];
    api.statusError = new ApiError(
      422,
      "INTEGRATION_PROVIDER_NOT_AVAILABLE",
      "raw-provider-msg",
    );
    await mount();
    await click(copy.activation.action);

    expect(text()).toContain(copy.errors.providerUnavailable);
    expect(text()).not.toContain("raw-provider-msg");
  });

  test("an unknown failure shows the generic message", async () => {
    api.rows = [tested()];
    api.statusError = new ApiError(500, "INTERNAL_ERROR", "boom-details");
    await mount();
    await click(copy.activation.action);

    expect(text()).toContain(copy.errors.generic);
    expect(text()).not.toContain("boom-details");
    expect(buttonState(copy.activation.action)).toBe("enabled");
  });
});
