# pstack models for Capy agents. Read by scripts/capy-pstack-models.sh, which writes ~/.cursor/rules/pstack-models.mdc on each boot.
# budget: small (medium)
# fallback how explorer and why investigators: particle/particle-1 · low, when Grok is unavailable.
# note swarm arms that only collect or check things (no writes): xai/grok-4.7 · low fast.
# note bulk mechanical arms (codemods, summaries, sweeps with a checkable result): particle/particle-1 · medium, or zai/glm-5.3-flash · low.
# note Kimi K3.1 Pro has no medium, so it runs at high.

| Role | Capy model |
|---|---|
| feature, refactoring | claude-code/claude-opus-5-5 · medium |
| bug-fix | claude-code/claude-opus-5-5 · medium |
| perf-issue | claude-code/claude-opus-5-5 · high |
| hillclimb | claude-code/claude-opus-5-5 · high |
| judgment and prose | claude-code/claude-opus-5-5 · medium |
| hardest tasks | claude-code/claude-opus-5-5 · xhigh |
| how explorer | xai/grok-4.7 · medium fast |
| how explainer | claude-code/claude-opus-5-5 · medium |
| why investigators | xai/grok-4.7 · medium fast |
| why synthesizer | claude-code/claude-opus-5-5 · medium |
| reflect tooling | claude-code/claude-sonnet-5-5 · medium |
| reflect judgment, divergent, synthesizer | claude-code/claude-opus-5-5 · medium |
| arena runners | claude-code/claude-opus-5-5 · medium, openai/gpt-6.1-sol · medium, moonshotai/kimi-k3.1-pro · high |
| arena cross-judge pool | openai/gpt-6.1-sol · medium, claude-code/claude-opus-5-5 · medium, claude-code/claude-sonnet-5-5 · medium |
| swarm workers | claude-code/claude-sonnet-5-5 · medium |
| architect runners | claude-code/claude-opus-5-5 · high, openai/gpt-6.1-sol · high, moonshotai/kimi-k3.1-pro · high |
| interrogate reviewers | claude-code/claude-opus-5-5 · medium, openai/gpt-6.1-sol · medium, particle/particle-1 · high |
