> **Status:** Long-term strategic vision and phasing. This document *elaborates* the product
> direction with evidence gathered during development; it defers to the governing
> [Vision Constitution](RepoGuide_Vision_Constitution.md) and the root [VISION.md](../../VISION.md)
> (mission + guiding principles) on any conflict. Where those define *what RepoGuide is and the
> principles it must uphold*, this document argues *how the evidence says to sequence the work* —
> in particular, it is a concrete elaboration of Principle 7, "Trust through evidence, not
> confidence." The phase shape here maps onto `ROADMAP.md`'s phase tracking.

# RepoGuide — long-term vision: becoming a tool developers trust in their daily loop

## North star

Not "a tool that answers questions about code." A tool developers instinctively open *before*
making a change, because it consistently makes them safer, faster, or more informed — and because
when it doesn't know something, it says so instead of guessing. The second half of that sentence
matters as much as the first. This session's evidence says so directly.

## The core design principle this session actually validated

Every real reliability win this project has had came from the same move, applied repeatedly in
different places: **take a judgment the small model was making unreliably, and replace it with a
computable fact wherever the answer is structurally determinable.**

- Branch-logic conditions → a symbolic interpreter, not the model applying the condition.
- "What depends on this?" → a graph lookup, not the model inferring from retrieved text.
- "Is this query about impact analysis or explanation?" → a deterministic classifier, with the
  model's own classification demoted to a fallback.
- The demo's actual reliability ranking, discovered empirically: deterministic graph tools >
  evidence-cited-but-unsynthesized (`gather_evidence`) > model-synthesized narrative
  (`ask_repoguide`). That ordering isn't a coincidence — it's the amount of unchecked model
  judgment in the path, in order.

And every real trust *failure* found this session had the same shape: the model (or the pipeline
around it) produced a confident, well-formatted, cited-looking answer with no signal that anything
was wrong — `gate: pass` at `coverageScore: 0`, the graph tool silently answering about the wrong
node, the fabricated Draft Listing integration claim. Not one of the dangerous failures was "the
tool said it didn't know." Every dangerous failure was "the tool was confidently wrong and gave no
indication."

**The implication for everything going forward:** every new capability should be built with two
questions asked up front — can this be made deterministic/computable instead of asking the model
to judge it, and if not, does the failure mode default to a loud, honest "I don't have enough to
answer this" rather than a plausible-sounding guess. A tool used daily only survives the first time
it's confidently wrong if that's rare and the tool clearly told the developer it was uncertain.
It does not survive being confidently wrong silently, even once, more than a couple of times,
because the entire value proposition is "trust this instead of re-checking it yourself" — and that
proposition breaks completely the moment a developer gets burned and has to start re-checking
everything anyway.

## What this reframes from "bug list" to "product architecture"

**The coverage-gate gap isn't a polish item — it's the single highest-leverage fix for the actual
mission.** A developer who hits `gate: pass` on a low-evidence answer once will stop trusting the
green checkmark permanently, and there's no polish afterward that undoes that — trust is
asymmetric, expensive to build and cheap to lose. This should be treated as core infrastructure,
not backlog.

**The graph-tool mis-targeting bug is the same category of problem, at higher severity, because
the graph tools are the part of the product with the least room for error.** They're deterministic
specifically so developers can stop double-checking them. A deterministic tool that's silently
wrong undermines the one part of the system that was supposed to be beyond doubt — worse for
long-term trust than the LLM-synthesis failures, even though it looks like a smaller bug.

**RepositoryBrain being empty matters more here than it did for demo purposes.** In a demo, nobody
pokes at it. In the "accumulates value over time" mission, an accumulated-project-intelligence
layer is close to the actual differentiator between RepoGuide and "a RAG chatbot pointed at your
repo." Right now that differentiator is wired up but non-functional. Worth treating as a real
product gap, not a footnote.

**The "improves as tested" idea (ADR-001's V3) deserves to be a first-class capability, not an
appendix.** This session alone surfaced roughly ten distinct, real, previously-unknown defects.
Each one, once found, is fixable — but only if it's captured permanently so it can never silently
regress. A growing regression/eval harness that every real defect gets added to is what turns
"we found and fixed a bug" into "the product provably gets more reliable the longer it's used,"
which is the actual stated north star of this project, not just a demo talking point.

**Change-impact analysis (blast radius, dependency-safe refactoring) is the most defensible
product direction to build out deliberately, not incidentally.** It's already the most reliable
category in the whole system (deterministic graph, no model judgment in the path), it directly
answers the stated mission ("assessing change impact... reducing engineering risk"), and unlike
narrative Q&A it doesn't have an open-ended hallucination surface. Doubling down here — richer
graph edges (DI-mediated, external-service, cross-language), more sophisticated blast-radius
framing, "is this safe to change" as a first-class workflow rather than one question type among
many — is where the product can differentiate without fighting the small model's actual ceiling.

**Language coverage is a real long-term liability, not just a documented gap.** The whole system's
best behavior is currently concentrated on exactly the two languages CraftConnect happens to use
(Python, JS/TS — the only ones with real tree-sitter logical-unit extraction). That's convenient
for one demo and a real limitation for "developers trust this tool" as a general claim across a
Java/Go/Rust/C# shop. Already logged in ROADMAP; worth keeping as a visible, not buried, priority.

**Scale hasn't been proven, only glimpsed.** The Guava indexing hang and the background-annotation
scale finding are early signals, not a stress test. "Works great on an 800-file repo" and "works
on an enterprise monorepo" are different claims, and the stated design principle ("repositories of
every size") hasn't actually been tested at the size where it would break, if it breaks.

## What this doesn't change

The demo-focused work in flight right now — the graph-tool mis-targeting fix, the flagship
threshold fix — still matters and still comes first chronologically, for a practical reason: none
of the long-term work above is trustworthy to build on top of a foundation that's currently known
to be silently wrong in a specific, reproduced way. Fix the foundation, then build the vision on
top of it. But the sequencing is now explicit rather than implicit: near-term fixes exist to
protect the parts of the product that are already the right long-term bet (the graph tools), not
just to survive one recording session.

## A phased shape, not a rigid plan

**Phase 0 (in flight):** fix what's currently known to be silently wrong — graph-tool
mis-targeting, the threshold-question cascade. Protects the foundation the rest of this rests on.

**Phase 1 — trust infrastructure:** coverage-based gating, the evidence-anchored critique loop,
get ADR-001 into the actual repo. This is the "never be confidently wrong without saying so" layer.

**Phase 2 — the accumulating layer:** turn every defect found (this session's ~10 and future ones)
into permanent regression coverage; get RepositoryBrain actually populated and contributing.
This is the "gets better the longer it's used" layer — the actual differentiator.

**Phase 3 — double down on the proven differentiator:** deepen change-impact/blast-radius
analysis as a first-class workflow, since it's both the most reliable category today and the
most directly aligned with the stated mission.

**Phase 4 — breadth:** close the per-language extraction gap, stress-test at real enterprise
scale. Necessary for "developers" to mean more than "developers on Python/JS-TS repos the size of
CraftConnect," but correctly sequenced after the trust foundation, not before it.
