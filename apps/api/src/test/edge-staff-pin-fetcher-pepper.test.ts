// The edge's staff pin page request asks for its outlet's peppers (beads
// legend-ideif, legend-jmsdx; PRD v1.7 §3 F6 "Staf — PIN Perangkat", EDG-02).
// `peppers=<versions held, e.g. 2,3>` (empty = none held) goes out only over https (a pepper never travels in clear text) and falls
// back for an older cloud whose strict query refuses it: revision + peppers,
// then revision only, then neither. Any other error is not retried.
import { describe, expect, it } from "vitest";
import {
  createStaffPinRecordsFetcher,
  EdgeCloudHttpError,
} from "../edge/cloud-http.ts";

const signal = new AbortController().signal;

/** Fetcher over a stub cloud; records each request URL, answers by `reply`. */
function stubFetcher(
  cloudUrl: string,
  reply: (url: URL) => Response,
  pepperHave?: () => readonly number[],
) {
  const urls: URL[] = [];
  const fetchPage = createStaffPinRecordsFetcher({
    cloudUrl,
    credential: "edge-credential",
    pepperHave,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return reply(url);
    }) as typeof fetch,
  });
  return { fetchPage, urls };
}

const SECURE = "wss://cloud.example.test/api/edge-link";
const PLAIN = "ws://cloud.example.test/api/edge-link";
const ok = () => new Response("{}", { status: 200 });
const refuse = (status: number) => new Response("{}", { status });

describe("legend-jmsdx the staff pin fetcher asks for peppers", () => {
  it("over https the first request carries peppers=<held versions> and revision=1", async () => {
    const { fetchPage, urls } = stubFetcher(SECURE, ok, () => [2, 3]);
    await fetchPage(null, signal);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get("peppers")).toBe("2,3");
    expect(urls[0]!.searchParams.get("revision")).toBe("1");
  });

  it("asks again for the versions held on every page (empty value = none yet)", async () => {
    let held: number[] = [];
    const { fetchPage, urls } = stubFetcher(SECURE, ok, () => held);
    await fetchPage(null, signal);
    held = [2];
    await fetchPage("cursor-1", signal);
    expect(urls.map((url) => url.searchParams.get("peppers"))).toEqual([
      "",
      "2",
    ]);
    expect(urls[0]!.searchParams.has("peppers")).toBe(true);
  });

  it("never sends peppers over a non-https (ws://) cloud url", async () => {
    const { fetchPage, urls } = stubFetcher(PLAIN, ok, () => [2]);
    await fetchPage(null, signal);
    await fetchPage("cursor-1", signal);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url.searchParams.has("peppers")).toBe(false);
  });

  it("sends no peppers when the edge is not wired to ask for them", async () => {
    const { fetchPage, urls } = stubFetcher(SECURE, ok);
    await fetchPage(null, signal);
    expect(urls[0]!.searchParams.has("peppers")).toBe(false);
    expect(urls[0]!.searchParams.get("revision")).toBe("1");
  });

  it("a 400 retries with revision=1 but without peppers", async () => {
    const { fetchPage, urls } = stubFetcher(
      SECURE,
      (url) => (url.searchParams.has("peppers") ? refuse(400) : ok()),
      () => [2],
    );
    await fetchPage("cursor-1", signal);
    expect(urls).toHaveLength(2);
    expect(urls[1]!.searchParams.has("peppers")).toBe(false);
    expect(urls[1]!.searchParams.get("revision")).toBe("1");
    expect(urls[1]!.searchParams.get("since")).toBe("cursor-1");
  });

  it("a cloud that refuses both is retried a third time without either", async () => {
    const { fetchPage, urls } = stubFetcher(
      SECURE,
      (url) =>
        url.searchParams.has("peppers") || url.searchParams.has("revision")
          ? refuse(400)
          : ok(),
      () => [2],
    );
    await fetchPage(null, signal);
    expect(urls).toHaveLength(3);
    expect(urls[2]!.searchParams.has("peppers")).toBe(false);
    expect(urls[2]!.searchParams.has("revision")).toBe(false);
  });

  it("a 400 on the last variant is thrown as HTTP_400, after 3 requests", async () => {
    const { fetchPage, urls } = stubFetcher(
      SECURE,
      () => refuse(400),
      () => [2],
    );
    const error = await fetchPage(null, signal).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_400");
    expect(urls).toHaveLength(3);
  });

  it("a non-400 error is thrown after 1 request, with no retry", async () => {
    const { fetchPage, urls } = stubFetcher(
      SECURE,
      () => refuse(500),
      () => [2],
    );
    const error = await fetchPage(null, signal).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).not.toBe("HTTP_400");
    expect(urls).toHaveLength(1);
  });
});
