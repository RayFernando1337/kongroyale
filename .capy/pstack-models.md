# pstack models for Capy agents. Read by scripts/capy-pstack-models.sh, which writes ~/.cursor/rules/pstack-models.mdc on each boot.
# budget: small (medium)
# note no OpenAI models: the GPT subscription is cancelled. Spend the Claude and SuperGrok plans first, particle-1 for cheap work.
# fallback how explorer and why investigators: particle/particle-1 · low, when Grok is unavailable.
# note swarm arms that only collect or check things (no writes): xai/grok-4.7 · low fast.
# note bulk mechanical arms (codemods, summaries, sweeps with a checkable result): particle/particle-1 · medium, or zai/glm-5.3-flash · low.
# note CI-log reading, PR babysitting and review follow-up once the code is written: claude-code/claude-sonnet-5-5 · medium, or xai/grok-4.7 · low fast for read-only checks.
# note escalate to claude-code/claude-opus-5-5 · high for root-cause bugs, shared/ and determinism changes, and measurement design where the brief's premise may be wrong.
# note Kimi K3.1 Pro has no medium, so it runs at high.

| Role | Capy model |
|---|---|
| feature, refactoring | claude-code/claude-sonnet-5-5 · high |
| bug-fix | claude-code/claude-opus-5-5 · medium |
| perf-issue | claude-code/claude-opus-5-5 · medium |
| hillclimb | claude-code/claude-sonnet-5-5 · high |
| judgment and prose | claude-code/claude-sonnet-5-5 · high |
| hardest tasks | claude-code/claude-opus-5-5 · xhigh |
| how explorer | xai/grok-4.7 · medium fast |
| how explainer | claude-code/claude-sonnet-5-5 · medium |
| why investigators | xai/grok-4.7 · medium fast |
| why synthesizer | claude-code/claude-sonnet-5-5 · high |
| reflect tooling | particle/particle-1 · medium |
| reflect judgment, divergent, synthesizer | claude-code/claude-sonnet-5-5 · high |
| arena runners | claude-code/claude-opus-5-5 · medium, xai/grok-4.7 · high, moonshotai/kimi-k3.1-pro · high |
| arena cross-judge pool | claude-code/claude-opus-5-5 · medium, claude-code/claude-sonnet-5-5 · medium, xai/grok-4.7 · medium |
| swarm workers | claude-code/claude-sonnet-5-5 · medium |
| architect runners | claude-code/claude-opus-5-5 · high, xai/grok-4.7 · high, moonshotai/kimi-k3.1-pro · high |
| interrogate reviewers | claude-code/claude-opus-5-5 · medium, xai/grok-4.7 · high, particle/particle-1 · high |
