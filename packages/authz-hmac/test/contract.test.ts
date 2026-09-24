import { describeAuthzPortContract } from "@kohaku-ui/port-contracts";
import { createHmacAuthzPort } from "../src/index.js";

describeAuthzPortContract("createHmacAuthzPort", () => ({ port: createHmacAuthzPort("contract-secret") }));
