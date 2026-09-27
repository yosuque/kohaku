import { describeRateLimitStorePortContract } from "@kohaku-ui/port-contracts";
import { createMemoryRateLimitStore } from "../src/rate-limit.js";

describeRateLimitStorePortContract("createMemoryRateLimitStore", () => ({
  port: createMemoryRateLimitStore(),
}));
