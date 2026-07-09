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

    return {
        GATE_ANNOTATION_TEXT: GATE_ANNOTATION_TEXT,
        GATE_PREPEND_TEXTS: GATE_PREPEND_TEXTS,
        extractGatePrepends: extractGatePrepends,
        splitOnAnnotationMarker: splitOnAnnotationMarker,
        deriveGateChipInfo: deriveGateChipInfo
    };
});
