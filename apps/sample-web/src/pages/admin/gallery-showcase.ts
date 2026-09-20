/**
 * The $ref the showcase's own `window.kohaku.fetchData(...)` call requests, and the value GalleryTab.tsx
 * declares as the Spec node's `data.$ref` for the showcase preview. The sandbox bridge enforces
 * exact-string-equality allowlisting between a fetchData call and the node's declared $ref
 * (packages/sandbox/src/host-bridge.ts's binding.fetch handler) — a mismatch silently denies every fetch
 * (ERR_REF_NOT_ALLOWED) with no visible error, since the guest still calls ready() in its `finally`.
 * Deliberately a `query://gallery/*` ref rather than a real-looking `query://sales/*` one: the artifact
 * itself should say plainly that it reads canned gallery fixture data (nothing behind this ref is a real
 * query), which matters because screenshots of this tab are the project's only visual evidence that the
 * design kit renders. test/gallery-showcase.test.ts asserts the HTML actually contains this ref.
 */
export const GALLERY_CANNED_REF = "query://gallery/canned";

/**
 * A hand-written L2 artifact that uses every class of the built-in design kit. Mounted by GalleryTab
 * through the real SandboxFrame (same iframe, CSP, theme and kit injection as production), so it is the
 * kit's living style guide and the visual regression material for the kit CSS. It must pass the L2 lint
 * with the kit and enforceTokenColors (see test/gallery-showcase.test.ts) — no raw colors, no unknown classes.
 */
export const GALLERY_SHOWCASE_HTML = [
  "<!DOCTYPE html><html><head><title>Design kit showcase</title>",
  "<style>.gallery-note{border-left:3px solid var(--kohaku-color-primary);padding-left:var(--kohaku-space-3)}</style>",
  "</head><body>",
  '<div class="k-stack">',
  '  <div class="k-card">',
  '    <div class="k-card-title">Sales by region <span class="k-badge k-badge-info">FY2026 Q3</span></div>',
  '    <div class="k-subtitle mb-4">Kit showcase — every component class in one widget</div>',
  '    <div class="k-grid k-grid-3 mb-4">',
  '      <div class="k-kpi"><span class="k-kpi-label">Total sales</span><span class="k-kpi-value" id="kpi-total">—</span><span class="k-kpi-delta is-up">▲ +12.4%</span></div>',
  '      <div class="k-kpi"><span class="k-kpi-label">Orders</span><span class="k-kpi-value">1,208</span><span class="k-kpi-delta is-down">▼ -3.1%</span></div>',
  '      <div class="k-kpi"><span class="k-kpi-label">Regions</span><span class="k-kpi-value" id="kpi-regions">—</span><span class="k-kpi-delta">— 0%</span></div>',
  "    </div>",
  '    <table class="k-table"><thead><tr><th>Region</th><th class="k-num">Sales</th><th>Trend</th></tr></thead><tbody id="rows"></tbody></table>',
  '    <div class="k-row mt-4">',
  '      <button class="k-btn k-btn-primary" type="button">Export</button>',
  '      <button class="k-btn k-btn-secondary" type="button">Refresh</button>',
  '      <button class="k-btn k-btn-danger" type="button" disabled>Delete</button>',
  '      <span class="k-badge">default</span><span class="k-badge k-badge-positive">up</span><span class="k-badge k-badge-negative">down</span><span class="k-badge k-badge-warning">stale</span>',
  "    </div>",
  "  </div>",
  '  <div class="k-card">',
  '    <div class="k-card-title">Sales chart</div>',
  '    <svg class="k-chart" viewBox="0 0 400 160" role="img" aria-label="Sales by region bar chart" id="chart"></svg>',
  '    <svg class="k-chart hidden" style="display:none" viewBox="0 0 1 1" aria-hidden="true"><g class="k-axis k-gridline k-tick k-axis-label k-series-1 k-series-2 k-series-3 k-series-4 k-series-5 k-series-6 k-series-7 k-bar k-line"></g></svg>',
  "  </div>",
  '  <div class="k-grid k-grid-2">',
  '    <div class="k-card"><div class="k-title">Filters</div><div class="k-stack mt-3"><label class="k-label" for="q">Query</label><input class="k-input" id="q" placeholder="Search region"><label class="k-label" for="s">Period</label><select class="k-select" id="s"><option>FY2026 Q3</option></select></div></div>',
  '    <div class="k-card"><div class="k-title">States</div><div class="k-stack mt-3"><div class="k-notice k-notice-info">Loading…</div><div class="k-notice k-notice-positive">Saved</div><div class="k-notice k-notice-warning">Data may be stale</div><div class="k-notice k-notice-negative">Could not load</div><div class="k-notice">No data for this period</div><p class="gallery-note text-sm text-muted">Custom CSS is fine when it uses tokens.</p></div></div>',
  "  </div>",
  '  <div class="k-grid k-grid-4 hidden" style="display:none"><div class="k-muted k-num tabular-nums text-right w-full">hidden grid</div></div>',
  "</div>",
  "<script>",
  "async function main() {",
  "  try {",
  `    const data = await window.kohaku.fetchData(${JSON.stringify(GALLERY_CANNED_REF)});`,
  "    const rows = data.rows.slice(0, 6);",
  "    const total = rows.reduce((s, r) => s + Number(r.sales || 0), 0);",
  '    document.getElementById("kpi-total").textContent = total.toLocaleString();',
  '    document.getElementById("kpi-regions").textContent = String(rows.length);',
  '    const tbody = document.getElementById("rows");',
  "    for (const r of rows) {",
  '      const tr = document.createElement("tr");',
  '      tr.innerHTML = "<td>" + String(r.region) + "</td><td class=\\"k-num\\">" + Number(r.sales || 0).toLocaleString() + "</td><td><span class=\\"k-badge k-badge-positive\\">▲</span></td>";',
  "      tbody.appendChild(tr);",
  "    }",
  '    const svg = document.getElementById("chart");',
  "    const max = Math.max(1, ...rows.map((r) => Number(r.sales || 0)));",
  '    let html = "<line class=\\"k-axis\\" x1=\\"40\\" y1=\\"130\\" x2=\\"390\\" y2=\\"130\\"></line><line class=\\"k-axis\\" x1=\\"40\\" y1=\\"10\\" x2=\\"40\\" y2=\\"130\\"></line>";',
  "    for (let i = 0; i < 4; i++) {",
  "      const y = 130 - (i + 1) * 30;",
  '      html += "<line class=\\"k-gridline\\" x1=\\"40\\" y1=\\"" + y + "\\" x2=\\"390\\" y2=\\"" + y + "\\"></line><text class=\\"k-tick\\" x=\\"36\\" y=\\"" + (y + 4) + "\\" text-anchor=\\"end\\">" + Math.round((max * (i + 1)) / 4).toLocaleString() + "</text>";',
  "    }",
  "    rows.forEach((r, i) => {",
  "      const h = (Number(r.sales || 0) / max) * 110;",
  "      const x = 50 + i * 55;",
  '      html += "<rect class=\\"k-bar k-series-" + ((i % 7) + 1) + "\\" x=\\"" + x + "\\" y=\\"" + (130 - h) + "\\" width=\\"40\\" height=\\"" + h + "\\"></rect><text class=\\"k-tick\\" x=\\"" + (x + 20) + "\\" y=\\"145\\" text-anchor=\\"middle\\">" + String(r.region) + "</text>";',
  "    });",
  '    html += "<path class=\\"k-line k-series-2\\" d=\\"M50 120 L105 100 L160 110 L215 80 L270 90 L325 60\\"></path><text class=\\"k-axis-label\\" x=\\"215\\" y=\\"158\\" text-anchor=\\"middle\\">Region</text>";',
  "    svg.innerHTML = html;",
  "  } catch (e) {",
  '    document.getElementById("rows").innerHTML = "<tr><td colspan=\\"3\\"><div class=\\"k-notice k-notice-negative\\">Could not load data</div></td></tr>";',
  "  } finally {",
  "    window.kohaku.ready();",
  "  }",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");
