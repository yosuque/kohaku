/** Default width of a data-version bucket, in seconds. */
export const DEFAULT_BUCKET_SECONDS = 300;

/**
 * A `dataVersion` source for an upstream that has no version of its own (an MCP server exposes none): a string
 * that changes every `bucketSeconds` (default 300), `mcp:<floor(now / bucket)>`. Every Spec composed inside one
 * bucket carries the same version, and the data resolved for it is stamped with the same one, so the
 * renderer's stale-version check stays quiet inside a bucket and a cached Spec is refreshed once the bucket
 * turns over. `now` returns epoch milliseconds (default `Date.now`).
 */
export function mcpDataVersion(options: { bucketSeconds?: number; now?: () => number } = {}): () => string {
  const bucketSeconds = options.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error(`mcpDataVersion: bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }
  const now = options.now ?? Date.now;
  return () => `mcp:${Math.floor(now() / 1000 / bucketSeconds)}`;
}
