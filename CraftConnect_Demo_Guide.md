# CraftConnect Demo Guide (RepoGuide)

Practical guidance for demoing RepoGuide against CraftConnect live. Read the mental-model note
at the bottom before any demo.

## Prefer narrow, factual questions over open-ended "explain this feature" questions

**Ask specific, checkable questions.** RepoGuide's hallucination gate (`AnswerGate`) is strong at
what it actually verifies: fabricated **numbers, quoted strings, code blocks, and file paths** are
caught and blocked. Questions whose answers live in those forms stay in the gate's wheelhouse:

- "What is the confidence threshold in the customization interview agent?" (a specific value)
- "What instantiates `StoryGenerationAgent`?" / "What depends on `MissionOrchestratorAgent`?"
  (specific dependents/dependencies — these route to the program graph)
- "Where is `<symbol>` defined?" / "What does `<function>` return when `<condition>`?"

**Avoid open-ended "explain this whole feature" questions in a live demo.** Open-ended questions
invite the model to *synthesize a narrative*, and narrative synthesis is exactly where the gate
has **no coverage**: a fluent sentence that invents a relationship ("integrates seamlessly with
Draft Listing") contains no number/quote/code/path for the gate to check, so it can pass the gate
while being false. The gate does **not** verify relationship or integration claims — so narrow
factual questions remain the safest live-demo choice.

Concretely, in a recruiter demo: lead with the "what instantiates X / what depends on X" graph
questions and the specific-threshold questions. Those are the reliable, verifiable moments. Treat
"explain the whole X feature" as a stretch question, not a headline.

## The one-line mental model to internalize before any demo

> **`gateStatus: pass` covers numbers, quotes, code, and file-identity claims only — it means
> RepoGuide found none of those fabricated. It does NOT cover relationship or integration claims
> in prose (e.g. "X integrates with / depends on / uses / calls Y"), so a green gate does not, by
> itself, guarantee that every relationship or integration claim in the answer is true.** For
> open-ended feature explanations, read the answer critically and cross-check with
> `get_dependents` / `get_dependencies` before repeating a claim as fact.

State this plainly to yourself before demoing: a green gate is "no caught fabrications," not
"certified correct." The narrow factual questions above are where green genuinely means green.
