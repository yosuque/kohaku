import type { Command } from "commander";

/** Registers `kohaku component` (`validate` / `publish`). The runner module is loaded lazily by `validate`. */
export function register(program: Command): void {
  const component = program.command("component").description("Operations on component packages");

  component
    .command("validate")
    .argument("<file>", "JSON file of a ComponentDefinition")
    .description("Validate a component definition (JSON-serialized form)")
    .action(async (file: string) => {
      const { validateComponentFile } = await import("../commands.js");
      const issues = validateComponentFile(file);
      if (issues.length === 0) {
        console.log(`✓ ${file} is a valid ComponentDefinition`);
        return;
      }
      console.log(`✗ ${file} has ${issues.length} issue(s):`);
      for (const issue of issues) console.log(`  - ${issue.field}: ${issue.message}`);
      process.exitCode = 1;
    });

  component
    .command("publish")
    .description("(unimplemented) Publish a component to the federated registry")
    .action(() => {
      // "v0.2" refers to the protocol-envelope version (published, feature-gated), so keep the wording
      // distinct to avoid conflating it with an implementation milestone. Federated distribution is unimplemented in every current version.
      console.error(
        "component publish is planned for a future implementation milestone (federated distribution is unimplemented)",
      );
      process.exitCode = 1;
    });
}
