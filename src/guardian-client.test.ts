import { describe, expect, it } from "vitest";
import { GuardianClient, GuardianError, isApproved, type Verdict } from "./guardian-client.js";

const baseVerdict = (over: Partial<Verdict>): Verdict => ({
  schemaVersion: 1,
  outcome: "pending",
  reasonCode: "pending",
  humanReason: "",
  triggeringPolicyField: null,
  checks: [],
  policyVersion: 1,
  timestamp: new Date().toISOString(),
  ...over,
});

function fakeFetch(handlers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const h = handlers.shift();
    if (!h) throw new Error("no more handlers");
    return new Response(h.body === undefined ? "" : JSON.stringify(h.body), { status: h.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const mk = (impl: typeof fetch) => new GuardianClient({ baseUrl: "https://x/api/", apiKey: "k", fetchImpl: impl });

describe("requestVerification", () => {
  it("sends x-api-key and arbiter=policy and returns requestHash", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "1", requestHash: "0xh", description: "", status: "PENDING" } }]);
    const r = await mk(f.impl).requestVerification({
      escrowAddress: "0x1111111111111111111111111111111111111111",
      prompt: "p",
      proposedTx: { protocol: "uniswap", chainId: 1, to: "0x22", data: "0x", value: "0" },
    });
    expect(r.requestHash).toBe("0xh");
    expect(f.calls[0].url).toBe("https://x/api/transactions");
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("k");
    expect(h.authorization).toBeUndefined();
    expect(JSON.parse(f.calls[0].init.body as string).arbiter).toBe("policy");
  });

  it("fails closed on 2xx without requestHash", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "1", status: "PENDING" } }]);
    await expect(
      mk(f.impl).requestVerification({
        escrowAddress: "0x11", prompt: "p",
        proposedTx: { protocol: "uniswap", chainId: 1, to: "0x22", data: "0x", value: "0" },
      }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("maps 401 to auth error", async () => {
    const f = fakeFetch([{ status: 401, body: { message: "Invalid API key" } }]);
    await expect(
      mk(f.impl).requestVerification({
        escrowAddress: "0x11", prompt: "p",
        proposedTx: { protocol: "uniswap", chainId: 1, to: "0x22", data: "0x", value: "0" },
      }),
    ).rejects.toMatchObject({ kind: "auth", httpStatus: 401 });
  });
});

describe("waitForVerification", () => {
  it("polls through pending / missing verdict to a terminal one", async () => {
    const f = fakeFetch([
      { status: 200, body: {} },
      { status: 200, body: { verdict: baseVerdict({ outcome: "pending" }) } },
      { status: 500, body: { message: "boom" } },
      { status: 200, body: { verdict: baseVerdict({ outcome: "approved", reasonCode: "allowed" }) } },
    ]);
    const v = await mk(f.impl).waitForVerification("0xh", { initialDelayMs: 1, maxDelayMs: 2 });
    expect(v.outcome).toBe("approved");
    expect(f.calls).toHaveLength(4);
    expect(f.calls[0].url).toBe("https://x/api/transactions/0xh/approval-status");
  });

  it("aborts immediately on 403", async () => {
    const f = fakeFetch([{ status: 403, body: { message: "nope" } }]);
    await expect(mk(f.impl).waitForVerification("0xh", { initialDelayMs: 1 })).rejects.toMatchObject({ kind: "auth" });
    expect(f.calls).toHaveLength(1);
  });

  it("times out (blocked) if never terminal", async () => {
    const f = fakeFetch(Array.from({ length: 50 }, () => ({ status: 200, body: { verdict: baseVerdict({}) } })));
    await expect(
      mk(f.impl).waitForVerification("0xh", { deadlineMs: 20, initialDelayMs: 5, maxDelayMs: 5 }),
    ).rejects.toSatisfy((e: unknown) => e instanceof GuardianError && e.kind === "timeout");
  });
});

describe("isApproved", () => {
  it("requires outcome=approved AND reasonCode=allowed", () => {
    expect(isApproved(baseVerdict({ outcome: "approved", reasonCode: "allowed" }))).toBe(true);
    expect(isApproved(baseVerdict({ outcome: "approved", reasonCode: "pending" }))).toBe(false);
    expect(isApproved(baseVerdict({ outcome: "rejected", reasonCode: "allowed" }))).toBe(false);
    expect(isApproved(null)).toBe(false);
  });
});
