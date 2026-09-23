import { readFileSync } from "node:fs";

/** The CLI's own version (cli/package.json), read at runtime so src/ and the published dist/ agree. */
export const CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
