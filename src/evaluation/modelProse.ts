/**
 * Separates the MODEL-authored portion of an answer from the DETERMINISTIC insight blocks
 * RepoGuide appends after it.
 *
 * WHY THIS IS ITS OWN MODULE. `adversarialSuiteRunner.ts` calls `main()` unconditionally at
 * import time (it is a CLI entry point), so nothing inside it can be unit-tested without
 * running the whole suite against a live model. This split is pure string logic and is the
 * thing most worth pinning with tests, so it lives here.
 *
 * WHY THE SPLIT MATTERS. `MentorInsightRenderer` appends a graph-derived block -- Affected
 * Files, Affected Symbols, risk level -- after the model's prose (see the four
 * `lines.push('\n\n### ...')` calls in `src/mentor/mentorInsightRenderer.ts`). That block is
 * RepoGuide's own deterministic output and is generally CORRECT even when the prose above it
 * is fabricated. Scoring the concatenated string therefore lets the appendix answer for the
 * model in both directions: a `required` marker the model never produced can be satisfied by
 * the appendix, and a `mustNotContain` marker the model never said can be violated by it.
 *
 * The measured case that motivated this, from the real recorded run of `adv-hot-3` in
 * `adversarial-suite-results.json`: asked what depends on `execute`, the model named ten
 * dependents and all ten are verified false -- each one DEFINES `execute` rather than calling
 * it, and the sole real caller (`base_agent.py:171`) is never mentioned in the prose. Yet
 * both `base_agent` and `BaseAgent` appear in the full answer string, at index 2941 and 3116,
 * inside the Change Impact block starting at ~2900. Scored whole, a `required: ["base_agent"]`
 * assertion PASSES a 10/10 fabrication. That blind spot is why the case sat in the permanent
 * suite recorded as a pass.
 */

/** Section headers `MentorInsightRenderer` emits. Must stay in sync with the four
 *  `lines.push('\n\n### ...')` calls in `src/mentor/mentorInsightRenderer.ts`
 *  (`src/test/evaluation/modelProse.test.ts` pins the list against that file). */
export const MENTOR_INSIGHT_HEADERS = [
    '### Architecture Insights',
    '### Change Impact Analysis',
    '### Recommended Learning Path',
    '### Refactoring Opportunities'
];

/**
 * The model-authored portion of `answer`, with any appended deterministic insight block
 * removed. Returns the answer unchanged when no block was appended -- the common case (2 of
 * 37 answers in the recorded adversarial run carried one).
 *
 * Cuts at the EARLIEST header found rather than assuming a particular one: `render()`
 * switches on a single recommendation type so at most one block is emitted per answer, and
 * everything from that point on is appended output regardless of which type it was.
 */
export function modelProseOnly(answer: string): string {
    let cut = -1;
    for (const header of MENTOR_INSIGHT_HEADERS) {
        const at = answer.indexOf(header);
        if (at >= 0 && (cut < 0 || at < cut)) {
            cut = at;
        }
    }
    return cut < 0 ? answer : answer.slice(0, cut);
}
