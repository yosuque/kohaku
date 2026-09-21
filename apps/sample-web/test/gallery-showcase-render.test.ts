import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { GALLERY_CANNED_REF, GALLERY_SHOWCASE_HTML } from "../src/pages/admin/gallery-showcase.js";

/**
 * Executes GALLERY_SHOWCASE_HTML's own inline <script> for real (via jsdom's `runScripts: "dangerously"`)
 * against a `window.kohaku.fetchData` stub that mirrors the sandbox bridge's actual allowlist behavior
 * (packages/sandbox/src/host-bridge.ts's binding.fetch: exact-string-equality against the declared $ref,
 * ERR_REF_NOT_ALLOWED on any other ref). The two lint-only tests in gallery-showcase.test.ts operate purely
 * on the HTML string and cannot see this: a mismatch between the ref the showcase's script requests and the
 * $ref GalleryTab.tsx declares on the Spec node is invisible to a static check, since the guest still calls
 * ready() from its own catch/finally on a denied fetch — it fails completely silently in production. This
 * test is the one piece of automated evidence that the showcase actually renders real content, not just that
 * its markup and lint are clean.
 */

const CANNED_DATA = {
  columns: [
    { key: "region", label: "Region", type: "string" },
    { key: "sales", label: "Sales", type: "number" },
  ],
  rows: [
    { region: "East", sales: 1_234_000 },
    { region: "West", sales: 987_000 },
    { region: "North", sales: 654_000 },
    { region: "South", sales: 1_120_000 },
    { region: "Central", sales: 432_000 },
  ],
  dataVersion: "gallery",
};

/** Mounts GALLERY_SHOWCASE_HTML in a real jsdom window, running its script for real, and waits for ready(). */
async function renderShowcase(): Promise<{ dom: JSDOM; ready: boolean; requestedRef: string | null }> {
  let ready = false;
  let requestedRef: string | null = null;
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const dom = new JSDOM(GALLERY_SHOWCASE_HTML, {
    runScripts: "dangerously",
    beforeParse(window) {
      // Deliberately narrower than a real sandbox: only fetchData/ready are exercised by this artifact, but
      // the fetchData behavior itself is the real allowlist rule, not a permissive stand-in.
      (window as unknown as { kohaku: Record<string, unknown> }).kohaku = {
        fetchData: (ref: string) => {
          requestedRef = ref;
          if (ref !== GALLERY_CANNED_REF) {
            return Promise.reject(new Error(`ERR_REF_NOT_ALLOWED: ${ref}`));
          }
          return Promise.resolve(CANNED_DATA);
        },
        ready: () => {
          ready = true;
          resolveReady();
        },
        emit: () => {},
        onProps: () => {},
      };
    },
  });

  await Promise.race([
    readyPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for ready()")), 2000),
    ),
  ]);
  return { dom, ready, requestedRef };
}

describe("gallery showcase artifact (rendered)", () => {
  it("requests exactly the ref GalleryTab declares, and actually renders the canned data", async () => {
    const { dom, ready, requestedRef } = await renderShowcase();
    try {
      // The root-cause assertion: the ref the script asked for must equal the ref the Spec node declares
      // (GalleryTab.tsx's Preview). This is the exact equality the sandbox bridge enforces in production.
      expect(requestedRef).toBe(GALLERY_CANNED_REF);
      expect(ready).toBe(true);

      const doc = dom.window.document;
      expect(doc.getElementById("kpi-total")?.textContent).not.toBe("—");
      expect(doc.getElementById("kpi-regions")?.textContent).not.toBe("—");
      expect(doc.querySelectorAll("#rows tr").length).toBeGreaterThan(0);
      expect(doc.querySelectorAll("#chart rect.k-bar").length).toBeGreaterThan(0);
    } finally {
      dom.window.close();
    }
  });
});
