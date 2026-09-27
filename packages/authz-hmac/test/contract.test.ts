import { describeApprovalPortContract, describeAuthzPortContract } from "@kohaku-ui/port-contracts";
import { createHmacApprovalPort, createHmacAuthzPort, createMemoryApprovalStore } from "../src/index.js";

describeAuthzPortContract("createHmacAuthzPort", () => ({ port: createHmacAuthzPort("contract-secret") }), {
  revocation: true,
});

describeApprovalPortContract("createHmacApprovalPort (no store)", () => ({
  port: createHmacApprovalPort("contract-secret"),
}));

describeApprovalPortContract(
  "createHmacApprovalPort (with createMemoryApprovalStore)",
  () => ({ port: createHmacApprovalPort("contract-secret", { store: createMemoryApprovalStore() }) }),
  { singleUse: true },
);
