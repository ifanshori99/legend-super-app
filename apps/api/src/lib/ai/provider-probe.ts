import type { AiProviderTestErrorCode } from "@starter/shared/ai";
import { aiProviderNetwork } from "./provider-factory";
import { checkAiUrl, type HostResolver } from "./url-guard";

// One-shot connection test for a tenant's OpenAI-compatible provider. Never
// throws and never returns, logs, or keeps provider error text or the key:
// the result is a status plus a code from a fixed catalogue.

export type ProbeResult =
  | { status: "ok"; errorCode: null }
  | { status: "failed"; errorCode: AiProviderTestErrorCode };

export type ProbeOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  resolve?: HostResolver;
};

const MAX_TIMEOUT_MS = 15_000;

const failed = (errorCode: AiProviderTestErrorCode): ProbeResult => ({
  status: "failed",
  errorCode,
});

function discard(res: Response) {
  void res.body?.cancel().catch(() => undefined);
}

export async function probeOpenAiCompatible(
  options: ProbeOptions,
): Promise<ProbeResult> {
  try {
    const network = aiProviderNetwork();
    const doFetch = options.fetch ?? network.fetch;
    const resolve = options.resolve ?? network.resolve;
    const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    if (await checkAiUrl(url, true, resolve)) return failed("URL_BLOCKED");

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          stream: false,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(options.timeoutMs, MAX_TIMEOUT_MS),
        ),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError")
        return failed("TIMEOUT");
      if ((error as { code?: string } | null)?.code === "EAI_BLOCKED")
        return failed("URL_BLOCKED");
      return failed("NETWORK_ERROR");
    }

    if (res.status >= 300 && res.status < 400) {
      discard(res);
      return failed("REDIRECT_REFUSED");
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        const json = (await res.json()) as { choices?: unknown } | null;
        return Array.isArray(json?.choices)
          ? { status: "ok", errorCode: null }
          : failed("BAD_RESPONSE");
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        return failed(
          name === "TimeoutError" || name === "AbortError"
            ? "TIMEOUT"
            : "BAD_RESPONSE",
        );
      }
    }
    discard(res);
    if (res.status === 401 || res.status === 403) return failed("AUTH_FAILED");
    if (res.status === 404) return failed("NOT_FOUND");
    if (res.status === 400 || res.status === 422)
      return failed("REQUEST_REJECTED");
    if (res.status === 429) return failed("RATE_LIMITED");
    return failed("PROVIDER_ERROR");
  } catch {
    return failed("NETWORK_ERROR");
  }
}
