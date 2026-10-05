import { createKohakuClient, type KohakuClient, type Transport } from "@kohaku-ui/client";

/**
 * The `KohakuClient` of a `--rest <baseUrl>` command (`explain`, `evidence export`, `usage export`): the
 * trailing slash of the base URL is dropped once, `headers` (already parsed from the repeated `--header`
 * flags) go on every request, and `transport` is the test injection point (the client's own default, the
 * global fetch, applies when omitted).
 *
 * Imports the heavy `@kohaku-ui/client`, so it may only be loaded from the lazily imported command modules.
 */
export function createRestClient(
  rest: string,
  headers: Record<string, string>,
  transport?: Transport,
): KohakuClient {
  return createKohakuClient({
    baseUrl: rest.replace(/\/$/, ""),
    headers: () => headers,
    ...(transport != null ? { transport } : {}),
  });
}
