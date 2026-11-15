import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

const webRoot = new URL("../apps/web/src/", import.meta.url);
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const ts = rootRequire("typescript");
const reactPaths = Object.fromEntries(
  ["react", "react/jsx-runtime"].map((specifier) => [
    specifier,
    pathToFileURL(webRequire.resolve(specifier)).href,
  ]),
);
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
globalThis.__leaveDocumentsAccepted = false;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@/lib/env": "export const API_URL='https://api.example.test';",
      "@/components/i18n": "export const useT = () => (key) => key;",
      "@/features/hris-requests/hooks":
        "export const useLeaveTypes=()=>({data:[],isPending:false,isError:false}); export const useLeaveBalances=()=>({data:[],isPending:false,isError:false});",
      "@/features/hris-requests/storage-capabilities/hooks":
        "export const useStorageCapabilities=()=>({documentsAccepted:globalThis.__leaveDocumentsAccepted});",
      "@tanstack/react-query":
        "export const useQuery=()=>globalThis.__leaveCapabilityState; export const queryOptions=(options)=>options;",
      "../../ws10-attendance-qr/use-hydrated.ts":
        "export const useHydrated=()=>true;",
      "@/components/ui/input":
        "import {createElement} from 'react'; export const Input=(props)=>createElement('input',props);",
      "@/components/ui/textarea":
        "import {createElement} from 'react'; export const Textarea=(props)=>createElement('textarea',props);",
      "@/components/ui/button":
        "import {createElement} from 'react'; export const Button=({loading,size,...props})=>createElement('button',props);",
      "@/components/ui/form-field":
        "import {createElement} from 'react'; export const FormField=({children,hint,error})=>createElement('div',null,hint,error,children);",
      "@/components/ui/select":
        "export const Select=({children})=>children; export const SelectContent=({children})=>children; export const SelectItem=({children})=>children; export const SelectTrigger=({children})=>children; export const SelectValue=()=>null;",
      "@/features/ws10-payslip/format":
        "export const formatBusinessDate=(value)=>value;",
      "./request-form-loading.tsx":
        "export const FormLoading=()=>null; export const SubmitFailure=()=>null;",
      "lucide-react": "export const Info=()=>null;",
    };
    if (specifier in stubs)
      return { url: stub(stubs[specifier]), shortCircuit: true };
    if (specifier in reactPaths)
      return { url: reactPaths[specifier], shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const target = new URL(specifier.slice(2), webRoot);
      const extension = [".ts", ".tsx"].find((suffix) =>
        existsSync(`${fileURLToPath(target)}${suffix}`),
      );
      if (extension) return nextResolve(`${target.href}${extension}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});

const { uploadLeaveFile } =
  await import("../apps/web/src/features/hris-requests/leave-upload.ts");
const { RequestFormLeave } =
  await import("../apps/web/src/features/hris-requests/components/request-form-leave.tsx");
const { useStorageCapabilities } =
  await import("../apps/web/src/features/hris-requests/storage-capabilities/hooks.ts");
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.__leaveDocumentsAccepted = false;
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const uploaded = {
  data: { attachmentUploadRef: "00000000-0000-4000-8000-000000000003" },
};

test("[legend-3e8p0] capability hook fails closed for loading, malformed data and failed refetch with cached true", () => {
  for (const state of [
    { isSuccess: false, isPending: true },
    { isSuccess: true, data: {} },
    { isSuccess: true, data: { data: { documentsAccepted: "true" } } },
    {
      isSuccess: false,
      isError: true,
      data: { data: { documentsAccepted: true } },
    },
  ]) {
    globalThis.__leaveCapabilityState = state;
    assert.equal(useStorageCapabilities().documentsAccepted, false);
  }
  globalThis.__leaveCapabilityState = {
    isSuccess: true,
    data: { data: { documentsAccepted: true } },
  };
  assert.equal(useStorageCapabilities().documentsAccepted, true);
});

test("[legend-3e8p0] leave form offers photos only until PDF scanning is confirmed", () => {
  const markup = renderToStaticMarkup(
    React.createElement(RequestFormLeave, {
      busy: false,
      failed: false,
      year: 2026,
      onSubmit: () => {},
    }),
  );
  assert.match(markup, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(markup, /application\/pdf/);
});

test("[legend-3e8p0] leave form offers PDF only when capabilities allow documents", () => {
  globalThis.__leaveDocumentsAccepted = true;
  const markup = renderToStaticMarkup(
    React.createElement(RequestFormLeave, {
      busy: false,
      failed: false,
      year: 2026,
      onSubmit: () => {},
    }),
  );
  assert.match(markup, /accept="[^"]*application\/pdf[^"]*"/);
});

for (const file of [
  new File(["%PDF"], "medical.pdf", { type: "application/pdf" }),
  new File(["%PDF"], "medical.PDF", { type: "" }),
]) {
  test(`[legend-3e8p0] uploader refuses ${file.type || "PDF filename"} before POST when scanner is unavailable`, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/capabilities")
        ? json({ data: { documentsAccepted: false } })
        : json(uploaded, 201);
    };
    await assert.rejects(
      uploadLeaveFile(file),
      (error) =>
        error instanceof ApiError && error.code === "SCANNER_UNAVAILABLE",
    );
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, "/api/storage/capabilities");
    assert.equal(calls[0].init.credentials, "include");
  });
}

test("[legend-3e8p0] failed capability read refuses PDF without uploading bytes", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("offline");
  };
  await assert.rejects(
    uploadLeaveFile(
      new File(["%PDF"], "medical.pdf", { type: "application/pdf" }),
    ),
  );
  assert.equal(calls, 1);
});

test("[legend-3e8p0] malformed capability response cannot enable PDF", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ data: { documentsAccepted: "true" } });
  };
  await assert.rejects(
    uploadLeaveFile(
      new File(["%PDF"], "medical.pdf", { type: "application/pdf" }),
    ),
  );
  assert.equal(calls, 1);
});

test("[legend-3e8p0] scanner-enabled PDF upload verifies capabilities with cookies then posts original file", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? json({ data: { documentsAccepted: true } })
      : json(uploaded, 201);
  };
  assert.equal(
    await uploadLeaveFile(
      new File(["%PDF"], "medical.pdf", { type: "application/pdf" }),
    ),
    uploaded.data.attachmentUploadRef,
  );
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/api/storage/capabilities");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.credentials, "include");
  assert.equal(await calls[1].init.body.get("file").text(), "%PDF");
});

test("[legend-3e8p0] photos remain uploadable without PDF scanner", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(uploaded, 201);
  };
  assert.equal(
    await uploadLeaveFile(
      new File(["photo"], "medical.jpg", { type: "image/jpeg" }),
    ),
    uploaded.data.attachmentUploadRef,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
});
