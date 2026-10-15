# Evidence & Claim Hygiene

Use this file when the skill makes empirical or product-specific claims. Keep durable principles in `loop-principles.md`; keep dated product behavior in `product-loop-notes.md`; keep citations and verification notes here.

## Claim labels

Tag claims in references or examples when the evidence level matters:

- **[Principle]** Stable design rule derived from the loop model. Example: "Prefer deterministic checkers over AI judges."
- **[Product claim]** Current behavior of a specific tool. Must include a source and `Last verified`.
- **[Empirical claim]** Finding from a paper, benchmark, incident report, or field study. Must include a source.
- **[Heuristic]** Practitioner rule of thumb. Useful, but not a fact about all systems.
- **[Needs citation]** Keep the claim soft until sourced, or move it out of the main path.

## Citation standard

For any claim that could change over time, record:

```text
Claim:
Source:
Last verified:
Confidence: high | medium | low
Notes:
```

Prefer primary sources: official product docs, papers, vendor incident reports, public postmortems, or benchmark pages. Blog summaries are acceptable only when they link to primary evidence.

## Claims referenced, softened, or intentionally avoided

| Claim | Evidence status | Source / note |
|---|---|---|
| Claude Code `/goal` evaluator does not run commands or read files independently | **Product claim — high** | Anthropic Claude Code `/goal` docs. Last verified: 2026-07-12. |
| Transcript-only evaluators are weak verifiers | **Principle — high** | Follows from verifier independence: the evaluator sees only surfaced evidence. |
| Agents can game weak/evaluable objectives | **Empirical + principle — high** | Reward hacking/specification gaming literature; examples include modifying tests, scoring code, or exploiting loopholes. |
| Stronger models may exploit weak verifiers more effectively | **Empirical — medium** | Keep phrased as "may" unless tied to a specific benchmark/source. |
| Dependency-update automation is mechanically blind to malicious packages | **Principle — high** | Green build/test results do not prove package provenance or intent. |
| AI code-review comments get acted on less often than human comments | **Empirical — needs citation** | Do not use as a load-bearing claim until sourced. |
| Agents score in the low teens on end-to-end incident benchmarks | **Empirical — needs citation** | Keep softened or cite the exact benchmark. |
| Auto-compaction defaults such as 95% are product-specific | **Product claim — medium** | Keep in `product-loop-notes.md`; verify per tool/version. |

## How to phrase uncertain claims

Use:

> "This verifier is blind to malicious packages."

Avoid unless sourced:

> "Most malicious dependency PRs are auto-merged."

Use:

> "Incident write-actions should stay behind human gates unless they are narrow, pre-authorized, and reversible."

Avoid unless sourced:

> "Agents score in the low teens on all incident benchmarks."

Use:

> "Stronger models may find cheaper paths to green when the verifier is writable or underspecified."

Avoid unless sourced:

> "Stronger models always cheat more."
