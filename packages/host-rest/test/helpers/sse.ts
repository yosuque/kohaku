/** Extracts the capability of the first `event: spec` block from raw SSE text. Shared by tests that assert on
 * a capability delivered via /compose/stream (bind-capability.test.ts, write-capability.test.ts). */
export function specEventCapability(sse: string): string {
  for (const block of sse.split("\n\n")) {
    if (!/(^|\n)event: spec(\n|$)/.test(block)) continue;
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine == null) continue;
    const parsed = JSON.parse(dataLine.slice("data:".length).trim()) as { capability: string };
    return parsed.capability;
  }
  throw new Error("spec event not found in SSE");
}
