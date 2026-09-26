/**
 * Versions the generated project depends on. Mirrors pnpm-workspace.yaml's catalog (a test asserts the match) so a
 * quickstart project runs on exactly what this repository tests against.
 */
export const EXTERNAL_VERSIONS: Record<string, string> = {
  hono: "^4.13.8",
  "@hono/node-server": "^2.1.1",
  zod: "^4.6.5",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "@types/react": "^19.3.0",
  "@types/react-dom": "^19.3.0",
  "@types/node": "^26.6.2",
  vite: "^8.3.0",
  "@vitejs/plugin-react": "^6.1.1",
  tsx: "^4.23.15",
  typescript: "7.0.2",
  vitest: "^5.0.1",
  "@ai-sdk/anthropic": "^4.0.58",
  "@ai-sdk/openai-compatible": "^3.0.53",
};
