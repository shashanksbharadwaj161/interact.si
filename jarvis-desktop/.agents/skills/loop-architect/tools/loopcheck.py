#!/usr/bin/env python3
"""loopcheck — deterministic verification for loop-architect.

Two modes, one tool. Both are T1: deterministic, independent, no model calls.

  # 1. Repo self-check (default) — dogfood the repo's own doctrine in CI / pre-push.
  python3 tools/loopcheck.py [repo_root]

  # 2. Spec check — validate a user-authored LOOP.md before you trust it.
  python3 tools/loopcheck.py spec path/to/LOOP.md
  python3 tools/loopcheck.py spec path/to/loop-folder/   # looks for LOOP.md + VERIFIER.md

Self-check catches the audit's bug classes (stale tier, readiness off-by-one, dead
links, banned overclaims, template duplication). Spec-check enforces the control
anatomy the skill requires: a valid verifier tier, a convergence criterion with a
proof, a progress metric, four exits + a kill switch, a non-convergence policy, caps,
cadence, and a VERIFIER.md with immutability + a named blind spot + a liveness check.

ERRORs exit non-zero. WARNs are advisory (exit 0) — on purpose: a checker that cries
wolf gets muted, and approval fatigue is itself a failure mode. Promote a WARN to an
ERROR once its false-positive rate is zero. No third-party deps. Python 3.8+.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


class Report:
    def __init__(self, title: str):
        self.title = title
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def emit(self) -> int:
        print(f"loopcheck — {self.title}")
        if self.warnings:
            print(f"\n  {len(self.warnings)} warning(s):")
            for w in self.warnings:
                print(f"    WARN  {w}")
        if self.errors:
            print(f"\n  {len(self.errors)} error(s):")
            for e in self.errors:
                print(f"    ERROR {e}")
            print("\nFAIL")
            return 1
        print("\n  0 errors. PASS" + (f" ({len(self.warnings)} warnings)" if self.warnings else ""))
        return 0


# =============================================================================
# Mode 1 — repo self-check
# =============================================================================

def run_repo_check(repo: Path) -> int:
    r = Report(str(repo))
    skill = repo / "skills" / "loop-architect"

    def read(rel: str) -> str:
        p = repo / rel
        if not p.exists():
            r.err(f"missing file: {rel}")
            return ""
        return p.read_text(encoding="utf-8")

    def md_files() -> list[Path]:
        return [p for p in repo.rglob("*.md")
                if ".git" not in p.parts and ".context" not in p.parts]

    def rel(p: Path) -> str:
        return str(p.relative_to(repo))

    # Check 1: verifier tiers are only T1-T6 (no stale scheme, no phantom T3.5)
    tier_token = re.compile(r"\bT([0-9]+(?:\.[0-9]+)?)\b")
    tier_word = re.compile(r"\bTier\s+([0-9]+(?:\.[0-9]+)?)\b", re.IGNORECASE)
    for p in md_files():
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            for m in list(tier_token.finditer(line)) + list(tier_word.finditer(line)):
                val = float(m.group(1))
                if val != int(val) or not (1 <= int(val) <= 6):
                    r.err(f"{rel(p)}:{i} stale/invalid verifier tier '{m.group(0)}' (ladder is T1-T6)")
    loop_tpl = skill / "assets/templates/LOOP.md"
    if loop_tpl.exists() and "3.5" in loop_tpl.read_text(encoding="utf-8"):
        r.err(f"{rel(loop_tpl)} contains '3.5' — phantom tier in the output template")

    # Check 2: readiness checklist denominator == real item count
    text = read("skills/loop-architect/references/readiness-checklist.md")
    if text:
        count = len(re.findall(r"^\s*- \[ \]", text, re.MULTILINE))
        band = re.search(r"(\d+)\s*[-–]\s*(\d+)\s*\+\s*T1 verifier", text)
        if band and int(band.group(2)) != count:
            r.err(f"readiness-checklist.md: scoring band tops out at {band.group(2)} "
                  f"but there are {count} scoreable items")
        for m in re.finditer(r"Loop Readiness:\s*\d+\s*/\s*(\d+)", text):
            if int(m.group(1)) != count:
                r.err(f"readiness-checklist.md: example denominator /{m.group(1)} != item count {count}")
        readme = read("README.md")
        for m in re.finditer(r"(?:out of|x/|/)\s?(\d{2})\b", readme):
            n = int(m.group(1))
            if n in (27, 28, 29, 30) and n != count:
                r.err(f"README.md advertises readiness denominator {n} but checklist has {count} items")

    # Check 3: every file referenced in SKILL.md exists
    text = read("skills/loop-architect/SKILL.md")
    for m in re.finditer(r"`(references/[\w./-]+|assets/[\w./-]+)`", text):
        if not (skill / m.group(1)).exists():
            r.err(f"SKILL.md references '{m.group(1)}' which does not exist")

    # Check 4: banned overclaim phrasing
    banned = [(r"court transcript", "the retired 'court transcript' overclaim"),
              (r"defendant writes", "the retired 'defendant writes the transcript' overclaim")]
    for p in md_files():
        low = p.read_text(encoding="utf-8").lower()
        for pat, why in banned:
            if re.search(pat, low):
                r.err(f"{rel(p)} contains {why}")

    # Check 5: templates.md is guidance, not a second copy
    guidance = read("skills/loop-architect/references/templates.md")
    tpl_dir = skill / "assets/templates"
    if guidance and tpl_dir.exists():
        for tpl in tpl_dir.glob("*.md"):
            lines = [ln for ln in tpl.read_text(encoding="utf-8").splitlines() if len(ln.strip()) > 25]
            hits = sum(1 for ln in lines if ln in guidance)
            if hits >= 3:
                r.err(f"references/templates.md appears to duplicate {tpl.name} verbatim "
                      f"({hits} lines) — it must be guidance, not a second copy")

    # Check 6a (WARN): product notes must be dated, so staleness is visible
    notes = read("skills/loop-architect/references/product-loop-notes.md")
    if notes and "Last verified" not in notes:
        r.warn("product-loop-notes.md has no 'Last verified:' date — tool claims go stale silently")

    # Check 6 (WARN): empirical claims in principle files should carry a source
    claim_words = re.compile(r"\b(stud(?:y|ies)|benchmark|survey|percent|\d+\s?%)\b", re.IGNORECASE)
    allow = re.compile(r"\bT[1-6]\b|\bL[0-5]\b")
    for t in ["skills/loop-architect/references/loop-principles.md",
              "skills/loop-architect/references/verifier-patterns.md",
              "skills/loop-architect/references/risk-ladder.md",
              "skills/loop-architect/references/loop-types.md"]:
        for i, line in enumerate(read(t).splitlines(), 1):
            if claim_words.search(line) and not allow.search(line):
                if not ("http" in line or "](" in line or "cited" in line.lower()):
                    r.warn(f"{t}:{i} possible empirical claim without a nearby citation — "
                           f"verify it's hedged: {line.strip()[:80]}")

    return r.emit()


# =============================================================================
# Mode 2 — user spec check
# =============================================================================

def run_spec_check(target: Path) -> int:
    if target.is_dir():
        loop_path = target / "LOOP.md"
        verifier_path = target / "VERIFIER.md"
    else:
        loop_path = target
        verifier_path = target.parent / "VERIFIER.md"

    r = Report(f"spec: {loop_path}")
    if not loop_path.exists():
        r.err(f"no LOOP.md found at {loop_path}")
        return r.emit()

    loop = loop_path.read_text(encoding="utf-8")
    low = loop.lower()

    # Required sections — a missing one is a named failure mode, so it's an ERROR.
    required = [
        (r"(?im)^\**owner", "Owner (every loop has a named human)"),
        (r"(?im)^##+\s*goal", "Goal"),
        (r"(?i)convergence criterion", "Convergence criterion"),
        (r"(?i)\bproof\b", "Proof of the convergence criterion (an exact command/metric)"),
        (r"(?im)^##+\s*verifier", "Verifier section"),
        (r"(?im)^##+\s*progress metric", "Progress metric (else you can't tell progress from oscillation)"),
        (r"(?im)^##+\s*(stop rules|termination)", "Stop rules"),
        (r"(?i)non-convergence policy", "Non-convergence policy"),
        (r"(?im)^##+\s*budget", "Budget"),
        (r"(?im)^##+\s*cadence", "Cadence (else it's a script you ran once)"),
        (r"(?i)latency-to-detection", "Latency-to-detection (the master metric)"),
    ]
    for pat, name in required:
        if not re.search(pat, loop):
            r.err(f"LOOP.md missing: {name}")

    # Verifier tier present and valid; T5/T6 cap autonomy.
    tiers = sorted({int(m.group(1)) for m in re.finditer(r"\bT([1-6])\b", loop)})
    if not tiers:
        r.err("LOOP.md has no verifier tier (T1-T6) — score it on references/verifier-patterns.md")
    else:
        weakest = max(tiers)
        if weakest == 6:
            r.warn("verifier includes T6 (no oracle) — that part is not a loop; keep it report-only, never a gate")
        elif weakest == 5:
            r.warn("weakest verifier is T5 (transcript-only) — caps rollout at L1-L2; upgrade to T4/T1 before gating")

    # Four exits + kill switch, in the stop rules.
    exits = {"success": r"success",
             "exhaustion": r"exhaust|budget|cap hit|iteration cap",
             "no-progress": r"no.?progress|same (failure|test|error).{0,20}3",
             "escalation": r"escalat"}
    for name, pat in exits.items():
        if not re.search(pat, low):
            r.err(f"stop rules missing the '{name}' exit")
    if not re.search(r"kill.?switch", low):
        r.err("no kill switch — the loop needs a stop control the agent cannot reach")

    # Anti-cheat: the immutability question must be answered somewhere in LOOP.md.
    if not re.search(r"can the agent modify|immutab|read-only|codeowners|branch protection", low):
        r.warn("LOOP.md doesn't state whether the agent can modify its verifier — answer it explicitly")

    # Unfilled template placeholders.
    placeholders = re.findall(r"<[^>\n]{2,40}>", loop)
    if placeholders:
        sample = ", ".join(sorted(set(placeholders))[:5])
        r.warn(f"{len(placeholders)} unfilled placeholder(s) remain, e.g. {sample} — fill before running")

    # VERIFIER.md companion.
    if not verifier_path.exists():
        r.warn(f"no VERIFIER.md beside it ({verifier_path.name}) — the verifier deserves its own file")
    else:
        v = verifier_path.read_text(encoding="utf-8").lower()
        if not re.search(r"immutab|read-only|anti-cheat", v):
            r.warn("VERIFIER.md has no immutability/anti-cheat section")
        if not re.search(r"blind spot", v):
            r.err("VERIFIER.md names no blind spot — every verifier has one; naming it is the difference "
                  "between a design and a delusion")
        if not re.search(r"liveness|rejected anything|last 5 runs|never says no", v):
            r.warn("VERIFIER.md has no liveness check (has it rejected anything lately?)")

    return r.emit()


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "spec":
        if len(argv) < 3:
            print("usage: loopcheck.py spec <LOOP.md | folder>", file=sys.stderr)
            return 2
        return run_spec_check(Path(argv[2]).resolve())
    repo = Path(argv[1]).resolve() if len(argv) > 1 else Path(__file__).resolve().parent.parent
    return run_repo_check(repo)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
