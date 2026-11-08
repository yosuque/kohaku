/**
 * One component's entry in the language-neutral core-catalog JSON (see export-core-catalog.ts). Split out of
 * the script so the entry shape, including the `hasMigrateProps` marker, can be unit-tested without writing
 * the file.
 */

import type { ComponentDefinition } from "../src/index.js";
import { toPropsJsonSchema } from "../src/json-schema.js";

export function toCoreCatalogEntry(def: ComponentDefinition) {
  return {
    type: def.type,
    version: def.version,
    description: def.description,
    capabilities: def.capabilities,
    implementation: def.implementation ?? { kind: "native" },
    ...(def.generation != null ? { generation: def.generation } : {}),
    ...(def.fallback != null ? { fallbackType: def.fallback.type } : {}),
    // migrateProps is a function (like fallback.mapProps) and cannot be serialized; only a marker is
    // exported, and the function is hand-ported into the Python _MIGRATE_PROPS table. deprecated is plain
    // data, so it is exported as-is when present.
    ...(def.migrateProps != null ? { hasMigrateProps: true } : {}),
    ...(def.deprecated != null ? { deprecated: def.deprecated } : {}),
    propsSchema: toPropsJsonSchema(def),
  };
}
