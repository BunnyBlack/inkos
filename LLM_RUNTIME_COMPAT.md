# LLM runtime compatibility

## Architecture evidence

Base commit: `01e92ad2` on `feature/llm-runtime-compat`. Installed Pi AI and
Pi Agent Core: `0.67.1`. The existing paths are preserved:

1. CLI `agent`, CLI `interact`, TUI `agent-input`, Studio `/api/v1/agent` ->
   `runAgentSession` -> cached Pi Agent -> `guardedPiStream` -> `streamSimple`.
2. PipelineRunner -> BaseAgent text worker -> `runWorkerAgent` -> Pi lifecycle
   with `chatCompletion` transport -> native custom Chat/Responses/Anthropic
   or Pi adapter.
3. PipelineRunner -> structured worker -> `runWorkerAgentTool` ->
   `guardedPiStream` -> Pi tool calls -> host-validated result.

Before this change, the client factory equated positive `thinkingBudget` with
model capability, but the service resolver used registry capability. Main
sessions and structured workers omitted client runtime defaults. Studio
normalization dropped `modelMetadata`, its resolver did not accept the metadata,
and session cache identity omitted metadata and policy changes. Per-call model
selection changed ID/name while retaining the first model's metadata.

Pi's `dist/types.d.ts` separates `Model.reasoning` from
`SimpleStreamOptions.reasoning` and `thinkingBudgets`. Thinking levels are
minimal/low/medium/high/xhigh. Numerical budgets apply to token-based protocols.
`providers/simple-options.js` and the Anthropic adapter can increase serialized
max output to include thinking. OpenAI adapters encode roles and reasoning via
`Model.compat` and URL detection. InkOS preserves that downstream encoding.

## Minimal design

| Layer | Configuration | Responsibility |
| --- | --- | --- |
| Capability | `modelMetadata[model]`, model bank, Pi registry | Reasoning support, context window, output capacity |
| Runtime policy | Client defaults, `AgentSessionConfig.runtime` | Requested level, budget, temperature, total output reservation |
| Transport encoding | Protocol, metadata `compat`, endpoint compatibility, Pi adapter | Roles, token fields, effort mapping, thinking field format |

The alternative of replacing all transports would expand tool/streaming risk.
Adding provider/model special cases would preserve the split semantics. The
chosen design retains both call chains and shares policy at their boundaries.

`modelMetadata` gains optional `reasoning` and `compat`. Explicit metadata wins;
unknown reasoning models must declare their capability. A budget no longer
invents it. Developer role is an explicit compatibility choice.

`llm.reasoning` accepts off/minimal/low/medium/high/xhigh. Explicit policy wins
over the legacy budget switch. With no level, positive `thinkingBudget` requests
medium and supplies that budget to token-based adapters; zero requests no
thinking. A numerical budget is not an OpenAI effort or a universal server limit.

`off` means no reasoning requested: ordinary Chat Completions omits effort,
Responses uses `none`, and switch encodings send false. It cannot promise to
disable mandatory server reasoning. Conflicting `extra` reasoning fields cannot
reverse explicit policy. Unrelated nested extras survive. Input, tools and
output reservation remain controlled by the host/adapter.

Output reservation includes thinking and respects selected-model capacity.
Pi's later budget expansion cannot exceed the reservation. Invalid Anthropic
thinking allocations fail before sending a budget below 1024. Context guards
reserve the resolved total output.

All four Main Agent callers pass the policy. Studio explicit/default/discovered
selection retains the chosen service metadata for Main Agent and workers.
Metadata or policy changes rebuild cached sessions from committed transcript
history. Per-call and endpoint overrides resolve the actual selected model.

## Example custom protocol configuration

```json
{
  "reasoning": "high",
  "thinkingBudget": 2048,
  "modelMetadata": {
    "your-model-id": {
      "contextWindowTokens": 65536,
      "maxOutput": 8192,
      "reasoning": true,
      "compat": {
        "supportsDeveloperRole": false,
        "maxTokensField": "max_tokens",
        "thinkingFormat": "qwen-chat-template"
      }
    }
  }
}
```

`thinkingFormat` values are existing Pi protocol encoding labels, never
model-name selectors. Select the endpoint's actual protocol. The same request
tests use both Qwen3.8-Agent and an arbitrary ID. No live endpoint result is
claimed by these deterministic tests.

## TDD and validation plan

Use local `packages/core/node_modules/.bin/vitest.CMD` and `tsc.CMD` only.
Set `TEMP` and `TMP` to repository `temp`; do not use global pnpm.

- RED then GREEN: capability/policy separation, Main Agent defaults/cache,
  structured worker defaults, metadata retention and native/Pi request bodies.
- RED then GREEN: Studio/TUI propagation, adapter dialect preservation,
  reserved extras, output capacity, explicit off, Anthropic budget boundary,
  per-call model metadata, endpoint overrides and custom Anthropic protocol.
- Run targeted tests, full provider/session/worker suites, core full,
  `tsc --noEmit`, and `git diff --check` before reporting completion.
- Run Studio server and CLI/TUI integration suites. Build the workspace Core
  and CLI artifacts before CLI integration tests because those tests execute
  the real `packages/cli/dist/index.js` entrypoint.
- Preserve full session coverage of sub_agent continuation and repeat/total-hop
  guards. No compile-only substitution for those tests.

Existing timeouts remain: interactive first-event/idle 120/90 seconds and
pipeline streaming 300/180 seconds, with existing environment/per-call overrides.
No new provider/model-name dispatch is introduced.

## Verified results (2026-09-06)

- Runtime compatibility RED/GREEN coverage includes capability/policy separation,
  Pi-registry-only descriptor parity, provider-bank/custom endpoint parity,
  per-call model resolution, explicit `off`, Anthropic budget boundaries,
  native/Pi reasoning dialect, max-token field, developer-role and store parity,
  and selected-service Studio runtime policy propagation.
- Core full: 195 test files, 1,904 tests passed.
- Studio server full: 159 tests passed.
- CLI full: 42 test files, 233 tests passed after building Core and CLI workspace
  artifacts required by the real CLI integration entrypoint.
- Local `tsc.CMD --noEmit`: Core, Studio and CLI all exited 0.
- Core emit build and CLI emit build both exited 0.
- `git diff --check`: exited 0.
- No live Qwen server request was made. Request tests use the real Pi adapter
  with the network boundary replaced by deterministic responses.
Implementation remains uncommitted on `feature/llm-runtime-compat` for review.
Detailed test JSON is retained in repository `temp/llm-runtime-*.json`.
