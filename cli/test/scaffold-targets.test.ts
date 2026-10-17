import { describe, expect, it } from "vitest";
import { PORTS_TARGET } from "../src/scaffold-targets.js";
import { SERVER_TEMPLATE } from "../src/templates.js";

describe("scaffold ports", () => {
  it("tells the reader the host needs KOHAKU_CAPABILITY_SECRET (or dev: true for a local trial) before server.ts starts", () => {
    expect(PORTS_TARGET.next).toContain("KOHAKU_CAPABILITY_SECRET");
    expect(PORTS_TARGET.next).toContain("`dev: true`");
  });

  it("the server.ts install comment lists every @kohaku-ui package the three generated files import", () => {
    const comment = SERVER_TEMPLATE.slice(0, SERVER_TEMPLATE.indexOf("import { serve }"));
    for (const pkg of ["@kohaku-ui/host", "@kohaku-ui/llm", "@kohaku-ui/intents", "@kohaku-ui/spec-core"]) {
      expect(comment, pkg).toContain(pkg);
    }
  });
});
