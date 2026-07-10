// Pure, DOM-free rendering-decision logic for the AnswerGate trust-visibility UI
// (gate-status chip, gap/coverage notice bars, fence-annotation callouts). Kept
// separate from sidebar.js and dependency-free so it can be unit-tested directly
// under node:test without a DOM, while also loading as a plain global-scope
// <script> in the webview (no bundler/module loader is available there).
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.RepoGuideGateStatus = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // CROSS-REFERENCE: this literal must stay byte-identical to
    // UNVERIFIED_FENCE_ANNOTATION in src/query/answerGate.ts, so a fence that
    // failed conceptual-mode verification renders as a styled callout instead of
    // raw blockquote text. src/test/webviews/gateStatusRendering.test.ts reads
    // answerGate.ts's source and asserts this string appears there verbatim.
    var GATE_ANNOTATION_TEXT = '\n> ⚠️ RepoGuide could not verify this code block against the indexed evidence. It may be paraphrased or illustrative rather than verbatim source.\n';

    // CROSS-REFERENCE: these two literals must stay byte-identical to the
    // gap-check and conceptual-mode-fallback prepend sentences in
    // AnswerGate.verify() (src/query/answerGate.ts) -- same drift guard as above.
    var GATE_PREPEND_TEXTS = [
        'The evidence does not determine the full answer due to missing facts. ',
        'The retrieved evidence provides only partial architectural coverage. '
    ];

    /**
     * Strips any known gate-authored prepend sentence(s) off the FRONT of `text`,
     * repeatedly (both can stack -- see AnswerGate.verify()'s gap-check and
     * conceptual-mode-fallback steps, which can both fire on the same answer).
     * Returns the stripped sentences (trimmed, for display) plus the remaining
     * text with none of them at the front any more.
     */
    function extractGatePrepends(text) {
        var notices = [];
        var remaining = text || '';
        var strippedAny = true;
        while (strippedAny) {
            strippedAny = false;
            for (var i = 0; i < GATE_PREPEND_TEXTS.length; i++) {
                var prepend = GATE_PREPEND_TEXTS[i];
                if (remaining.indexOf(prepend) === 0) {
                    notices.push(prepend.trim());
                    remaining = remaining.slice(prepend.length);
                    strippedAny = true;
                }
            }
        }
        return { notices: notices, remaining: remaining };
    }

    /** Splits `text` on the fence-annotation marker, leaving the marker itself
     * out of the returned segments -- callers render a callout between segments. */
    function splitOnAnnotationMarker(text) {
        return (text || '').split(GATE_ANNOTATION_TEXT);
    }

    /**
     * Maps a gateStatus payload ({outcome, unsupportedCount, mode}, or null/
     * undefined for a path that never emitted the token -- e.g. legacy
     * explainSelection) to chip presentation. Always returns something: the
     * absent case is an intentional, honest "Unverified" chip, not silence.
     */
    function deriveGateChipInfo(gateStatus) {
        if (!gateStatus || !gateStatus.outcome) {
            return {
                text: 'Unverified',
                className: 'confidence-badge gate-status-unverified',
                title: 'This answer did not go through AnswerGate verification.'
            };
        }
        var modeSuffix = gateStatus.mode ? ' (' + gateStatus.mode + ' mode)' : '';
        if (gateStatus.outcome === 'pass') {
            return {
                text: 'Verified',
                className: 'confidence-badge gate-status-pass',
                title: 'Verified against the indexed evidence' + modeSuffix + '.'
            };
        }
        if (gateStatus.outcome === 'revise') {
            var count = gateStatus.unsupportedCount || 0;
            return {
                text: 'Verified with notes',
                className: 'confidence-badge gate-status-revise',
                title: 'Verified with ' + count + ' flagged item' + (count === 1 ? '' : 's') + modeSuffix + '.'
            };
        }
        return {
            text: 'Blocked',
            className: 'confidence-badge gate-status-block',
            title: 'Could not be verified against the indexed evidence' + modeSuffix + '.'
        };
    }

    /**
     * Maps live index-health data ({isIndexing, isAnnotating, lastIndexedAt})
     * to a persistent readiness-indicator presentation for the chat panel.
     * Mirrors deriveGateChipInfo's "always render something honest" philosophy:
     * a workspace that was never indexed must not read as "Ready" just because
     * isIndexing happens to be false. Four distinct states, in priority order:
     *   1. isIndexing        -- core index is being rebuilt, answers blocked.
     *   2. isAnnotating       -- core index done, background annotation still
     *                            running; the evidence pipeline is usable, so
     *                            submission is NOT blocked, but the badge stays
     *                            visibly short of "Ready" so a question asked
     *                            now doesn't look identical to a fully-settled one.
     *   3. never indexed      -- no lastIndexedAt yet.
     *   4. Ready              -- both indexing and annotation are complete.
     */
    function deriveReadinessStatus(health) {
        var data = health || {};
        if (data.isIndexing) {
            var progress = data.indexingProgress;
            var hasRealProgress = progress && typeof progress.total === 'number' && progress.total > 0;
            return {
                text: hasRealProgress
                    ? 'Indexing... ' + progress.current + '/' + progress.total + ' files'
                    : 'Indexing... (building understanding)',
                className: 'confidence-badge readiness-indexing',
                title: 'RepoGuide is rebuilding its index. Questions are disabled until this finishes.',
                blocksSubmission: true,
                disabledReason: 'Indexing in progress -- please wait before asking a question.'
            };
        }
        if (data.isAnnotating) {
            return {
                text: 'Finishing up (annotating files)...',
                className: 'confidence-badge readiness-annotating',
                title: 'Core indexing is complete; RepoGuide is still annotating files in the background. Answers are available now.',
                blocksSubmission: false,
                disabledReason: null
            };
        }
        if (!data.lastIndexedAt) {
            return {
                text: 'Not indexed yet',
                className: 'confidence-badge readiness-unindexed',
                title: 'Run "Rebuild Index" to build understanding of this workspace before asking questions.',
                blocksSubmission: true,
                disabledReason: 'Not indexed yet -- run "Rebuild Index" first.'
            };
        }
        return {
            text: 'Ready',
            className: 'confidence-badge readiness-ready',
            title: 'Index and annotations are up to date.',
            blocksSubmission: false,
            disabledReason: null
        };
    }

    /**
     * Maps live index-health data to the Index Health panel's "Status" row
     * text. Five states, distinct from deriveReadinessStatus's four -- this
     * one distinguishes "rebuilt this session" from "ready from a prior
     * session" (via lastIndexCompletedAt, set only when a rebuild commits
     * during the CURRENT extension host run) so completing a rebuild is
     * visibly different from an index that simply predates this session:
     *   1. isIndexing         -- "Indexing (N/total files)..." with real
     *                            numbers when available, else "Indexing...".
     *   2. isAnnotating        -- "Finishing up...".
     *   3. lastIndexCompletedAt -- "Indexing complete" (this session).
     *   4. lastIndexedAt        -- "Ready" (persisted from a prior session).
     *   5. otherwise            -- "Not indexed yet".
     */
    function deriveIndexHealthStatusText(health) {
        var data = health || {};
        if (data.isIndexing) {
            var progress = data.indexingProgress;
            if (progress && typeof progress.total === 'number' && progress.total > 0) {
                return 'Indexing (' + progress.current + '/' + progress.total + ' files)...';
            }
            return 'Indexing...';
        }
        if (data.isAnnotating) {
            return 'Finishing up...';
        }
        if (data.lastIndexCompletedAt) {
            return 'Indexing complete';
        }
        if (data.lastIndexedAt) {
            return 'Ready';
        }
        return 'Not indexed yet';
    }

    return {
        GATE_ANNOTATION_TEXT: GATE_ANNOTATION_TEXT,
        GATE_PREPEND_TEXTS: GATE_PREPEND_TEXTS,
        extractGatePrepends: extractGatePrepends,
        splitOnAnnotationMarker: splitOnAnnotationMarker,
        deriveGateChipInfo: deriveGateChipInfo,
        deriveReadinessStatus: deriveReadinessStatus,
        deriveIndexHealthStatusText: deriveIndexHealthStatusText
    };
});
