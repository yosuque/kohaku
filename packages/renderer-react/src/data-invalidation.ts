import {
  createDataInvalidationBus,
  type DataInvalidationBus,
  type DataInvalidationEvent,
  NOOP_INVALIDATION_BUS,
} from "@kohaku-ui/renderer-core";
import { createContext, useContext } from "react";

export type { DataInvalidationBus, DataInvalidationEvent };
// The bus entity (emitter) and types use the framework-free renderer-core as the single source of truth.
// What renderer-react adds is only the React Context wrapper (DataInvalidationContext / useDataInvalidation).
export { createDataInvalidationBus };

/** React Context that distributes the bus generated internally by RendererProvider. */
export const DataInvalidationContext = createContext<DataInvalidationBus | null>(null);

/** The data invalidation bus. Connected to the real bus only inside RendererProvider; outside, it returns a no-op. */
export function useDataInvalidation(): DataInvalidationBus {
  return useContext(DataInvalidationContext) ?? NOOP_INVALIDATION_BUS;
}
