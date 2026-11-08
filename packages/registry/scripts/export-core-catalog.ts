/**
 * Language-neutral JSON export of the core catalog (the TS implementation is canonical; the JSON is a derivative).
 * Run: pnpm --filter @kohaku-ui/registry run export-core-catalog
 *
 * The Python implementation (python/kohaku/src/kohaku/registry/core) builds its core catalog from this JSON
 * (type / version / description / capabilities / props JSON Schema / fallback target / generation / deprecated).
 * fallback's mapProps and migrateProps are functions and cannot be serialized to JSON, so both are hand-ported on
 * the Python side: fallback.mapProps into _FALLBACK_MAP_PROPS (the fallbackType match and the invariant that
 * "every fallbackType has a map_props implementation" are verified by Python-side tests), and migrateProps into
 * _MIGRATE_PROPS, with a `hasMigrateProps: true` marker in the JSON so a missing or stale port fails loudly.
 * CI checks for drift via the diff of re-running this script (the same pattern as facet-views).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreCatalog } from "../src/core/index.js";
import { toCoreCatalogEntry } from "./core-catalog-entry.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python/kohaku/src/kohaku/registry/_data/core-catalog.json",
);
mkdirSync(dirname(OUT_PATH), { recursive: true });

const components = [...coreCatalog.components]
  .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
  .map(toCoreCatalogEntry);

writeFileSync(
  OUT_PATH,
  JSON.stringify({ generatedBy: "packages/registry/scripts/export-core-catalog.ts", components }, null, 2) +
    "\n",
);
console.log(`generated: ${OUT_PATH} (${components.length} components)`);
