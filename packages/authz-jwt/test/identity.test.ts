import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtIdentityResolver, JwtIdentityError } from "../src/identity.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";

async function hs256(
  payload: Record<string, unknown>,
  opts: { iss?: string; aud?: string; expSeconds?: number } = {},
) {
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (opts.iss) jwt = jwt.setIssuer(opts.iss);
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  jwt = jwt.setExpirationTime(opts.expSeconds ?? "5m");
  return jwt.sign(new TextEncoder().encode(SECRET));
}

describe("createJwtIdentityResolver (HS256 shared secret)", () => {
  const resolver = createJwtIdentityResolver({
    key: { secret: SECRET },
    issuer: "https://issuer.test",
    audience: "kohaku",
  });

  it("maps sub / name / roles / tenant claims to a Principal and tenant", async () => {
    const token = await hs256(
      { sub: "u1", name: "Alice", roles: ["reviewer", "viewer"], tenant: "acme" },
      { iss: "https://issuer.test", aud: "kohaku" },
    );
    expect(await resolver.resolve(token)).toEqual({
      principal: { id: "u1", name: "Alice", roles: ["reviewer", "viewer"] },
      tenant: "acme",
    });
  });

  it("accepts a space-separated roles string and omits absent optional claims", async () => {
    const token = await hs256(
      { sub: "u2", roles: "admin reviewer" },
      { iss: "https://issuer.test", aud: "kohaku" },
    );
    expect(await resolver.resolve(token)).toEqual({ principal: { id: "u2", roles: ["admin", "reviewer"] } });
  });

  it("rejects a bad signature, wrong issuer / audience, and an expired token as INVALID_TOKEN", async () => {
    const good = { iss: "https://issuer.test", aud: "kohaku" };
    const other = createJwtIdentityResolver({ key: { secret: "another-secret-that-is-long-enough-0000" } });
    const forged = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("wrong-secret-that-is-long-enough-000000"));
    for (const token of [
      forged,
      await hs256({ sub: "u" }, { ...good, iss: "https://evil.test" }),
      await hs256({ sub: "u" }, { ...good, aud: "someone-else" }),
      await hs256({ sub: "u" }, { ...good, expSeconds: -60 }),
    ]) {
      await expect(resolver.resolve(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    }
    await expect(other.resolve("not-a-jwt")).rejects.toBeInstanceOf(JwtIdentityError);
  });

  it("drops non-string entries from an array roles claim rather than coercing them", async () => {
    const token = await hs256(
      { sub: "u5", roles: ["admin", 123, null, "viewer"] },
      { iss: "https://issuer.test", aud: "kohaku" },
    );
    expect(await resolver.resolve(token)).toEqual({ principal: { id: "u5", roles: ["admin", "viewer"] } });
  });

  it("a caller-supplied algorithms list controls acceptance directly: excluding the signing algorithm rejects, including it verifies", async () => {
    const secretKey = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ sub: "hs384" })
      .setProtectedHeader({ alg: "HS384" })
      .setExpirationTime("5m")
      .sign(secretKey);

    const excluding = createJwtIdentityResolver({ key: { secret: SECRET }, algorithms: ["HS256"] });
    await expect(excluding.resolve(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });

    const including = createJwtIdentityResolver({ key: { secret: SECRET }, algorithms: ["HS384"] });
    expect((await including.resolve(token)).principal.id).toBe("hs384");
  });

  it("rejects a token without a subject as MISSING_SUBJECT", async () => {
    const token = await hs256({ roles: ["admin"] }, { iss: "https://issuer.test", aud: "kohaku" });
    await expect(resolver.resolve(token)).rejects.toMatchObject({ code: "MISSING_SUBJECT" });
  });

  it("fromAuthorizationHeader: MISSING_TOKEN without a Bearer header, otherwise resolves", async () => {
    await expect(resolver.fromAuthorizationHeader(undefined)).rejects.toMatchObject({
      code: "MISSING_TOKEN",
    });
    const token = await hs256({ sub: "u3" }, { iss: "https://issuer.test", aud: "kohaku" });
    expect((await resolver.fromAuthorizationHeader(`Bearer ${token}`)).principal.id).toBe("u3");
  });

  it("honours custom claim names and a mapClaims override", async () => {
    const custom = createJwtIdentityResolver({
      key: { secret: SECRET },
      claims: { roles: "https://kohaku/roles", tenant: "org_id" },
    });
    const token = await hs256({ sub: "u4", "https://kohaku/roles": ["viewer"], org_id: "globex" });
    expect(await custom.resolve(token)).toEqual({
      principal: { id: "u4", roles: ["viewer"] },
      tenant: "globex",
    });

    const mapped = createJwtIdentityResolver({
      key: { secret: SECRET },
      mapClaims: (p) => ({ principal: { id: `user:${p.sub}`, roles: ["admin"] }, tenant: "fixed" }),
    });
    expect(await mapped.resolve(token)).toEqual({
      principal: { id: "user:u4", roles: ["admin"] },
      tenant: "fixed",
    });
  });
});

describe("createJwtIdentityResolver (JWKS)", () => {
  it("verifies an RS256 token against a local JWK set", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const resolver = createJwtIdentityResolver({ key: { jwks: { keys: [jwk] } } });
    const token = await new SignJWT({ sub: "rs", roles: ["admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setExpirationTime("5m")
      .sign(privateKey);
    expect((await resolver.resolve(token)).principal).toEqual({ id: "rs", roles: ["admin"] });
  });

  it("rejects an HS256 token when the key source is a JWK set (algorithm allow-list)", async () => {
    const { publicKey } = await generateKeyPair("RS256");
    const resolver = createJwtIdentityResolver({ key: { jwks: { keys: [await exportJWK(publicKey)] } } });
    const token = await hs256({ sub: "u" });
    await expect(resolver.resolve(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("honours a caller-supplied algorithms list that narrows the JWKS default (rejects an otherwise-valid RS256 token)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const resolver = createJwtIdentityResolver({ key: { jwks: { keys: [jwk] } }, algorithms: ["ES256"] });
    const token = await new SignJWT({ sub: "rs" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(resolver.resolve(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});
