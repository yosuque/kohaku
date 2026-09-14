<img src="https://raw.githubusercontent.com/yosuque/kohaku/main/docs/assets/kohaku-icon.png" alt="kohaku" width="112">

# kohaku (Python)

Python reference implementation of **Kohaku Protocol v0.1** — a backend for generating and serving
declarative UI Specs (UI as data, not code).

It is wire-compatible with the TypeScript reference implementation: canonical JSON is byte-identical, so
`intent.hash`, `specHash`, cache keys and the catalog fingerprint match across languages. Conformance is
verified in CI on every commit by the TypeScript CLI's black-box suite.

```bash
pip install kohaku            # core
pip install "kohaku[rest]"    # + the REST host (FastAPI)
pip install "kohaku[mcp]"     # + the MCP host
pip install "kohaku[llm]"     # + the OpenAI-compatible LLM adapter
```

- Protocol: [spec/SPEC.md](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md)
- Implementation guide, layout and known differences from the TypeScript port:
  [python/README.md](https://github.com/yosuque/kohaku/blob/main/python/README.md)
- Source and issues: https://github.com/yosuque/kohaku

Licensed under the Apache License, Version 2.0.
