# @kohaku-ui/evals

Evaluation harness for kohaku: golden Spec regression, LLM-as-judge scoring and a record/replay LLM.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/evals zod
```

## API notes

- `createSchemaExtractor({ llm, timeoutMs })`: `timeoutMs` (default 20000ms) bounds each extraction call with `AbortSignal.timeout`, so one slow candidate cannot stall the whole promotion evaluation.
- `JudgeInput.draft` is the schema actually being registered (`approve()`'s own draft argument) and is what the "schema fidelity" criterion scores against the HTML when present; `JudgeInput.suggestion` is the machine-extracted proposal attached at nomination, used only as context once `draft` is present, or scored directly when it is the only one supplied.
- `JudgeVerdict.rubricVariant` (`"full"` | `"no-schema"`) records whether the schema-fidelity criterion was scored for that call, dropped entirely when neither `draft` nor `suggestion` was supplied; `rubricVersion` is always the configured rubric's version string regardless of variant (`"0.4"` for the built-in default rubric — a version, not a weight or threshold).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/evals

Licensed under the Apache License, Version 2.0.
