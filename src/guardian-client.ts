/**
 * Minimal Nava Guardian REST client (developer preview).
 *
 * Contract (from https://docs.navalabs.ai/guardian/developers/*):
 *   POST {base}/transactions                              -> { id, requestHash, description, status }
 *   GET  {base}/transactions/:requestHash/approval-status -> { verdict?: Verdict, ... }
 *
 * Auth: `x-api-key: <agent api key>` only. Never send a bearer token alongside it.
 *
 * Safety rules baked in (all "fail closed"):
 *   - A 2xx POST without a non-empty string requestHash is an error.
 *   - POST is never retried automatically (retries create duplicate requests).
 *   - GET is polled with bounded exponential backoff; 401/403 abort immediately.
 *   - Only outcome === "approved" && reasonCode === "allowed" counts as approval.
 *   - Timeouts, malformed JSON, unknown outcomes => blocked.
 */

export type VerdictOutcome = "pending" | "approved" | "rejected";

export interface VerdictCheck {
  checkId: string;
  status: "passed" | "failed" | "not_checked";
  code: string | null;
  humanReason: string;
  triggeringPolicyField: string | null;
  legIndex: number | null;
}

export interface Verdict {
  schemaVersion: number;
  outcome: VerdictOutcome;
  reasonCode: string;
  humanReason: string;
  triggeringPolicyField: string | null;
  checks: VerdictCheck[];
  evidence?: {
    decodedAction?: unknown;
    observations?: unknown;
    sources?: unknown[];
  };
  policyVersion: number | null;
  latencyMs?: number;
  dataFreshness?: unknown;
  trust?: unknown;
  redaction?: unknown;
  usdNotional?: number | null;
  timestamp: string;
}

export interface ProposedTx {
  /** Venue identifier understood by Guardian's decoder, e.g. "uniswap". */
  protocol: string;
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Wei as a canonical decimal string, e.g. "0" (the arbiter rejects hex, despite the docs example). */
  value: string;
  [extra: string]: unknown;
}

export interface SubmitActionRequest {
  escrowAddress: `0x${string}`;
  prompt: string;
  proposedTx: ProposedTx;
  metadata?: Record<string, unknown>;
  contextLogs?: Record<string, unknown>;
  executionSignature?: string;
  arbiter?: "policy";
}

export interface SubmitActionResponse {
  id: string;
  requestHash: string;
  description: string;
  status: string;
}

/** Raw envelope returned by approval-status. Fields beyond `verdict` are kept for inspection. */
export interface ApprovalStatusEnvelope {
  verdict?: Verdict | null;
  [extra: string]: unknown;
}

export class GuardianError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "auth"
      | "bad_request"
      | "not_found"
      | "transport"
      | "malformed"
      | "timeout"
      | "rate_limited",
    public readonly httpStatus?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "GuardianError";
  }
}

export interface GuardianClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-request HTTP timeout. */
  requestTimeoutMs?: number;
}

export interface WaitOptions {
  /** Total wall-clock budget for polling. Default 60s. */
  deadlineMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onPoll?: (attempt: number, envelope: ApprovalStatusEnvelope | null) => void;
}

export class GuardianClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: GuardianClientOptions) {
    if (!opts.apiKey) throw new Error("GuardianClient: apiKey is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { "x-api-key": this.apiKey, accept: "application/json" };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: ctrl.signal });
    } catch (e) {
      throw new GuardianError(`transport failure on ${path}: ${(e as Error).message}`, "transport");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new GuardianError(`non-JSON response (${res.status}) on ${path}`, "malformed", res.status, text);
      }
    }
    return { status: res.status, body };
  }

  /**
   * Submit a proposed action. Never retried automatically: if this throws a transport
   * error you must reconcile (the request may or may not have been created) before resubmitting.
   */
  async requestVerification(req: SubmitActionRequest): Promise<SubmitActionResponse> {
    const { status, body } = await this.request("/transactions", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ arbiter: "policy", ...req }),
    });
    if (status === 401 || status === 403) throw new GuardianError(msg(body, "unauthorized"), "auth", status, body);
    if (status === 400) throw new GuardianError(msg(body, "bad request"), "bad_request", status, body);
    if (status === 429) throw new GuardianError("rate limited on POST", "rate_limited", status, body);
    if (status < 200 || status >= 300) throw new GuardianError(msg(body, `unexpected ${status}`), "transport", status, body);

    const r = body as Partial<SubmitActionResponse> | null;
    if (!r || typeof r.requestHash !== "string" || r.requestHash.length === 0) {
      throw new GuardianError("2xx without a non-empty requestHash; treat as blocked", "malformed", status, body);
    }
    return r as SubmitActionResponse;
  }

  /** Single read of the approval envelope. Safe to retry (idempotent GET). */
  async getApprovalStatus(requestHash: string): Promise<ApprovalStatusEnvelope> {
    const { status, body } = await this.request(
      `/transactions/${encodeURIComponent(requestHash)}/approval-status`,
      { method: "GET", headers: this.headers() },
    );
    if (status === 401 || status === 403) throw new GuardianError(msg(body, "unauthorized"), "auth", status, body);
    if (status === 404) throw new GuardianError("requestHash not found", "not_found", status, body);
    if (status === 429) throw new GuardianError("rate limited", "rate_limited", status, body);
    if (status >= 500) throw new GuardianError(`server error ${status}`, "transport", status, body);
    if (status !== 200 || body === null || typeof body !== "object") {
      throw new GuardianError(`unexpected approval-status response ${status}`, "malformed", status, body);
    }
    return body as ApprovalStatusEnvelope;
  }

  /**
   * Poll until a terminal verdict (approved / rejected) or the deadline.
   * Pending / missing verdicts keep polling; the deadline throws a "timeout" GuardianError.
   * Transient errors (429, 5xx, transport) are retried within the deadline; auth errors abort.
   */
  async waitForVerification(requestHash: string, opts: WaitOptions = {}): Promise<Verdict> {
    const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
    let delay = opts.initialDelayMs ?? 750;
    const maxDelay = opts.maxDelayMs ?? 5_000;
    let attempt = 0;

    while (true) {
      if (opts.signal?.aborted) throw new GuardianError("aborted by caller", "timeout");
      attempt++;
      let envelope: ApprovalStatusEnvelope | null = null;
      try {
        envelope = await this.getApprovalStatus(requestHash);
      } catch (e) {
        const err = e as GuardianError;
        if (err.kind === "auth" || err.kind === "not_found" || err.kind === "malformed") throw err;
        // rate_limited / transport: fall through and retry within the deadline
      }
      opts.onPoll?.(attempt, envelope);

      const v = envelope?.verdict ?? null;
      if (v && (v.outcome === "approved" || v.outcome === "rejected")) return v;

      if (Date.now() + delay > deadline) {
        throw new GuardianError(`no terminal verdict after ${attempt} polls; blocked`, "timeout");
      }
      await sleep(delay, opts.signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /** Convenience: submit then wait. */
  async verify(req: SubmitActionRequest, wait?: WaitOptions): Promise<{ requestHash: string; verdict: Verdict }> {
    const { requestHash } = await this.requestVerification(req);
    const verdict = await this.waitForVerification(requestHash, wait);
    return { requestHash, verdict };
  }
}

/**
 * The only condition under which execution may proceed.
 * Everything else (pending, rejected, malformed, unknown reason codes) is blocked.
 */
export function isApproved(v: Verdict | null | undefined): v is Verdict & { outcome: "approved" } {
  return !!v && v.outcome === "approved" && v.reasonCode === "allowed";
}

/** Human-friendly one-paragraph explanation for UI / logs. Never includes the API key. */
export function explainVerdict(v: Verdict): string {
  const failed = (v.checks ?? []).filter((c) => c.status === "failed");
  const lines = [
    `${v.outcome.toUpperCase()} (${v.reasonCode}) — ${v.humanReason}`,
    v.triggeringPolicyField ? `policy field: ${v.triggeringPolicyField}` : null,
    v.policyVersion != null ? `policy version: ${v.policyVersion}` : null,
    v.usdNotional != null ? `usd notional: ${v.usdNotional}` : null,
    ...failed.map(
      (c) => `  ✗ ${c.checkId}${c.legIndex != null ? `[leg ${c.legIndex}]` : ""}: ${c.code ?? "?"} — ${c.humanReason}`,
    ),
  ];
  return lines.filter(Boolean).join("\n");
}

function msg(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    return Array.isArray(m) ? m.join("; ") : String(m);
  }
  return fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
