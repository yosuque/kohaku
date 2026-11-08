/**
 * The cross-language cases for `@kohaku-ui/authz-hmac` / `kohaku.authz_hmac`, kept out of
 * generate-cross-language-fixtures.ts for size. They pin the BYTES of the two token kinds the HMAC reference
 * ports issue (a capability token and an approval token) for a fixed secret and a fixed issue time, so that:
 *
 * - the Python port verifies a token the TS port issued, and
 * - the Python port, given the same clock and the same jti, issues the identical string.
 *
 * Neither port exposes a clock or a jti source to inject (TS reads `Date.now` and `randomBytes` directly, and
 * adding a seam to a published API is out of scope for a mirror). Each case is therefore built from a token the
 * REAL TS port issued with `Date.now` pinned: its payload is decoded, the random jti is replaced by the case's
 * fixed one, and the result is re-signed with the same primitives the port uses. Everything else in the pinned
 * bytes (key order, number and string serialisation, the `tenant` omission rules, the exp arithmetic and the
 * TTL clamp) is exactly what the TS port produced; the final self-check verifies the pinned token through the real
 * port. `cross-language.test.ts` re-derives the payload from the real port on every run, so a TS-side change
 * to the serialisation fails there even though the fixture file itself is only regenerated on demand.
 */
import { createHmac } from "node:crypto";
import { createHmacApprovalPort, createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { Scope } from "@kohaku-ui/spec-core";

/** The shared secret of every case. */
export const AUTHZ_HMAC_SECRET = "golden-secret";
/** The pinned issue time, epoch seconds (2027-01-15T08:00:00Z). */
export const AUTHZ_HMAC_NOW_SECONDS = 1_800_000_000;

const APPROVAL_TOKEN_PREFIX = "kohaku-approval.v2.";
const APPROVAL_KEY_LABEL = "kohaku-approval-v2";

export interface CapabilityGoldenCase {
  name: string;
  principalId: string;
  scopes: Scope[];
  /** Omitted = the port's default TTL (600). */
  ttlSeconds?: number;
  /** Omitted = issued without a tenant. `""` is passed through (the port never signs an empty tenant). */
  tenant?: string;
  jti: string;
  token: string;
  /** What `verify` returns for `request` at the pinned time. `tenant: null` = no tenant. */
  expected: { ok: true; principalId: string; tenant: string | null } | { ok: false; reason: string };
  request: { kind: "read" | "write"; ref: string };
}

export interface ApprovalGoldenCase {
  name: string;
  input: { action: string; payloadHash: string; requesterId: string; approverId: string; tenant?: string };
  ttlSeconds?: number;
  jti: string;
  token: string;
  /** The `exp` the port signs: pinned time + min(ttl, 3600). */
  exp: number;
  request: { action: string; payloadHash: string; requesterId: string; tenant?: string };
}

export interface AuthzHmacFixtures {
  secret: string;
  nowSeconds: number;
  capabilities: CapabilityGoldenCase[];
  approvals: ApprovalGoldenCase[];
}

/** Runs `fn` with `Date.now` pinned to `nowSeconds`, restoring it afterwards (even on a throw). */
export async function withFixedNow<T>(nowSeconds: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => nowSeconds * 1000;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const b64urlEncode = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const b64urlDecode = (text: string): string => Buffer.from(text, "base64url").toString("utf8");

function capabilityPayload(token: string): string {
  return b64urlDecode(token.slice(0, token.lastIndexOf(".")));
}

function approvalPayload(token: string): string {
  const rest = token.slice(APPROVAL_TOKEN_PREFIX.length);
  return b64urlDecode(rest.slice(0, rest.lastIndexOf(".")));
}

/** Replaces the (random) `jti` claim of an issued token's payload JSON text with `jti`, preserving every other byte. */
export function swapJti(payloadJson: string, issuedJti: string, jti: string): string {
  const swapped = payloadJson.replace(`"jti":"${issuedJti}"`, `"jti":"${jti}"`);
  if (swapped === payloadJson)
    throw new Error("authz-hmac fixtures: the issued payload carries no jti to replace");
  return swapped;
}

function jtiOf(payloadJson: string): string {
  const jti = (JSON.parse(payloadJson) as { jti?: unknown }).jti;
  if (typeof jti !== "string") throw new Error("authz-hmac fixtures: the issued payload carries no jti");
  return jti;
}

function signCapability(payload: string): string {
  return createHmac("sha256", AUTHZ_HMAC_SECRET).update(payload).digest("base64url");
}

function signApproval(payload: string): string {
  const key = createHmac("sha256", AUTHZ_HMAC_SECRET).update(APPROVAL_KEY_LABEL).digest();
  return createHmac("sha256", key).update(APPROVAL_TOKEN_PREFIX).update(payload).digest("base64url");
}

/**
 * The capability token the real TS port issues for these arguments at the pinned time, with its jti swapped
 * for `jti` and re-signed. Exported so `cross-language.test.ts` re-derives the same string from the real port.
 */
export async function pinnedCapabilityToken(
  c: Pick<CapabilityGoldenCase, "principalId" | "scopes" | "ttlSeconds" | "tenant" | "jti">,
): Promise<string> {
  const authz = createHmacAuthzPort(AUTHZ_HMAC_SECRET);
  const issued = await withFixedNow(AUTHZ_HMAC_NOW_SECONDS, () =>
    authz.issueCapability(
      { id: c.principalId },
      c.scopes,
      c.ttlSeconds !== undefined || c.tenant !== undefined
        ? {
            ...(c.ttlSeconds !== undefined ? { ttlSeconds: c.ttlSeconds } : {}),
            ...(c.tenant !== undefined ? { tenant: c.tenant } : {}),
          }
        : undefined,
    ),
  );
  const payloadJson = capabilityPayload(issued);
  const payload = b64urlEncode(swapJti(payloadJson, jtiOf(payloadJson), c.jti));
  return `${payload}.${signCapability(payload)}`;
}

/** The approval-token counterpart of `pinnedCapabilityToken`. */
export async function pinnedApprovalToken(
  c: Pick<ApprovalGoldenCase, "input" | "ttlSeconds" | "jti">,
): Promise<string> {
  const approvals = createHmacApprovalPort(AUTHZ_HMAC_SECRET);
  const issued = await withFixedNow(AUTHZ_HMAC_NOW_SECONDS, () =>
    approvals.issueApproval(c.input, c.ttlSeconds !== undefined ? { ttlSeconds: c.ttlSeconds } : undefined),
  );
  const payloadJson = approvalPayload(issued);
  const payload = b64urlEncode(swapJti(payloadJson, jtiOf(payloadJson), c.jti));
  return `${APPROVAL_TOKEN_PREFIX}${payload}.${signApproval(payload)}`;
}

const CAPABILITY_CASES: Omit<CapabilityGoldenCase, "token" | "expected" | "request">[] = [
  {
    name: "plain read scope, default TTL, no tenant",
    principalId: "golden-user",
    scopes: [{ kind: "read", ref: "query://sales/summary?fy=2026" }],
    jti: "Z29sZGVuLWNhcC1qdGktMDE",
  },
  {
    name: "read + write scopes, explicit TTL, ASCII tenant",
    principalId: "golden-user",
    scopes: [
      { kind: "read", ref: "query://sales/summary?fy=2026&region=us" },
      { kind: "write", ref: "annotate" },
    ],
    ttlSeconds: 900,
    tenant: "acme",
    jti: "Z29sZGVuLWNhcC1qdGktMDI",
  },
  {
    name: "non-ASCII principal, scope ref and tenant (UTF-8 kept, not \\u-escaped)",
    principalId: "ユーザー",
    scopes: [{ kind: "read", ref: "query://sales/summary?region=東京" }],
    ttlSeconds: 3600,
    tenant: "株式会社アクメ",
    jti: "Z29sZGVuLWNhcC1qdGktMDM",
  },
  {
    name: "empty tenant is never signed",
    principalId: "golden-user",
    scopes: [{ kind: "read", ref: "query://sales/kpi" }],
    ttlSeconds: 60,
    tenant: "",
    jti: "Z29sZGVuLWNhcC1qdGktMDQ",
  },
  {
    name: "no scopes at all",
    principalId: "golden-user",
    scopes: [],
    jti: "Z29sZGVuLWNhcC1qdGktMDU",
  },
];

const PAYLOAD_HASH = `sha256:${"a".repeat(64)}`;

const APPROVAL_CASES: Omit<ApprovalGoldenCase, "token" | "exp" | "request">[] = [
  {
    name: "tenant-less approval, default TTL (the tenant key is omitted, not null)",
    input: {
      action: "publish",
      payloadHash: PAYLOAD_HASH,
      requesterId: "operator-1",
      approverId: "reviewer-1",
    },
    jti: "Z29sZGVuLWFwcHItMDE",
  },
  {
    name: "tenant-bound approval, explicit TTL",
    input: {
      action: "publish",
      payloadHash: PAYLOAD_HASH,
      requesterId: "operator-1",
      approverId: "reviewer-1",
      tenant: "acme",
    },
    ttlSeconds: 600,
    jti: "Z29sZGVuLWFwcHItMDI",
  },
  {
    name: "a TTL above the maximum is clamped to 3600; non-ASCII tenant and ids",
    input: {
      action: "publish",
      payloadHash: PAYLOAD_HASH,
      requesterId: "オペレーター",
      approverId: "レビュアー",
      tenant: "株式会社アクメ",
    },
    ttlSeconds: 86_400,
    jti: "Z29sZGVuLWFwcHItMDM",
  },
  {
    name: "an empty-string tenant is signed (unlike the capability token) and is distinct from none",
    input: {
      action: "annotate",
      payloadHash: PAYLOAD_HASH,
      requesterId: "operator-1",
      approverId: "reviewer-1",
      tenant: "",
    },
    jti: "Z29sZGVuLWFwcHItMDQ",
  },
];

export async function buildAuthzHmacFixtures(): Promise<AuthzHmacFixtures> {
  const authz = createHmacAuthzPort(AUTHZ_HMAC_SECRET);
  const approvals = createHmacApprovalPort(AUTHZ_HMAC_SECRET);

  const capabilities: CapabilityGoldenCase[] = [];
  for (const c of CAPABILITY_CASES) {
    const token = await pinnedCapabilityToken(c);
    const request = c.scopes[0] ?? { kind: "read" as const, ref: "query://sales/summary?fy=2026" };
    const verified = await withFixedNow(AUTHZ_HMAC_NOW_SECONDS, () => authz.verify(token, request));
    // `no scopes at all` must be denied; every other case must verify and echo the principal and tenant.
    const expectedTenant = c.tenant === undefined || c.tenant === "" ? null : c.tenant;
    let expected: CapabilityGoldenCase["expected"];
    if (c.scopes.length === 0) {
      if (verified.ok || verified.reason === undefined) {
        throw new Error(`authz-hmac fixtures: "${c.name}" should be denied (${JSON.stringify(verified)})`);
      }
      expected = { ok: false, reason: verified.reason };
    } else {
      if (
        !verified.ok ||
        verified.principal?.id !== c.principalId ||
        (verified.tenant ?? null) !== expectedTenant
      ) {
        throw new Error(`authz-hmac fixtures: "${c.name}" self-check failed (${JSON.stringify(verified)})`);
      }
      expected = { ok: true, principalId: c.principalId, tenant: expectedTenant };
    }
    capabilities.push({ ...c, token, expected, request });
  }

  const approvalCases: ApprovalGoldenCase[] = [];
  for (const c of APPROVAL_CASES) {
    const token = await pinnedApprovalToken(c);
    const request = {
      action: c.input.action,
      payloadHash: c.input.payloadHash,
      requesterId: c.input.requesterId,
      ...(c.input.tenant !== undefined ? { tenant: c.input.tenant } : {}),
    };
    const verified = await withFixedNow(AUTHZ_HMAC_NOW_SECONDS, () =>
      approvals.verifyApproval(token, request),
    );
    const exp = AUTHZ_HMAC_NOW_SECONDS + Math.min(c.ttlSeconds ?? 300, 3600);
    if (!verified.ok || verified.grant?.exp !== exp || verified.grant.jti !== c.jti) {
      throw new Error(`authz-hmac fixtures: "${c.name}" self-check failed (${JSON.stringify(verified)})`);
    }
    approvalCases.push({ ...c, token, exp, request });
  }

  return {
    secret: AUTHZ_HMAC_SECRET,
    nowSeconds: AUTHZ_HMAC_NOW_SECONDS,
    capabilities,
    approvals: approvalCases,
  };
}
