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
     * undefined for a path that never emitted the token) to chip presentation.
     * Always returns something: the absent case is an intentional, honest
     * "Unverified" chip, not silence.
     *
     * As of 2026-08-04 (defect #11) no production path takes the absent branch --
     * explainSelection, previously the one gate-bearing surface that skipped the
     * token, now emits it. Also consumed by the explain panel
     * (src/ui/explainPanel.ts), which loads this file via asWebviewUri so the
     * outcome -> chip mapping is defined exactly once.
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
     * Maps live index-health data ({isIndexing}) to the chat input's gating
     * state. Index Health is the single place for detailed progress/status
     * now (see deriveIndexHealthStatusText below) -- this function backs only
     * the minimal safety behavior that must survive independent of any
     * visual display: disable the textarea/send button while the CORE index
     * is genuinely being rebuilt (isIndexing), since the evidence pipeline
     * isn't usable yet. Deliberately does NOT gate on isAnnotating -- once
     * core indexing finishes, the evidence pipeline is usable even while
     * background file annotation continues, so input stays enabled.
     * placeholder/sendTitle are null in the not-blocked case so the caller
     * knows to fall back to the input's own default copy rather than this
     * function needing to know what that default is.
     */
    function deriveInputGatingState(health) {
        var data = health || {};
        if (data.isIndexing) {
            return {
                disabled: true,
                placeholder: 'Indexing in progress -- see Index Health for status',
                sendTitle: 'Indexing in progress -- please wait before asking a question.'
            };
        }
        return {
            disabled: false,
            placeholder: null,
            sendTitle: null
        };
    }

    /**
     * Maps live index-health data to the Index Health panel's "Status" row
     * text -- the single place detailed indexing progress/status is shown
     * (see CHANGELOG for the removed, redundant chat-panel status pill).
     * Five states, distinguishing "rebuilt this session" from "ready from a
     * prior session" (via lastIndexCompletedAt, set only when a rebuild
     * commits during the CURRENT extension host run) so completing a
     * rebuild is visibly different from an index that simply predates this
     * session:
     *   1. isIndexing         -- "Indexing (N/total files)..." with real
     *                            numbers when available, else "Indexing...".
     *   2. isAnnotating        -- "Ready -- annotating in background". Core
     *                            indexing is already done and the evidence
     *                            pipeline is already usable at this point
     *                            (deriveInputGatingState never gates on
     *                            isAnnotating) -- this state must lead with
     *                            "Ready" so it doesn't read as contradicting
     *                            the status bar/chat input, which already
     *                            show "Ready" at the same instant. No
     *                            "(X/Y files)" suffix: FileAnnotationEngine's
     *                            annotateFiles() doesn't report per-file
     *                            progress out (only an internal log line),
     *                            and indexManager.ts clears indexingProgress
     *                            to null in the same tick isAnnotating flips
     *                            true, before the background annotation work
     *                            even starts -- so there is no real number to
     *                            show without adding new tracking, and this
     *                            deliberately doesn't fake one.
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
            return 'Ready -- annotating in background';
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
        deriveInputGatingState: deriveInputGatingState,
        deriveIndexHealthStatusText: deriveIndexHealthStatusText
    };
});
