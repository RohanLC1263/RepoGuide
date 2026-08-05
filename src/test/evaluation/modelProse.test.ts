import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { modelProseOnly, MENTOR_INSIGHT_HEADERS } from '../../evaluation/modelProse';

/**
 * Pins the split between model-authored prose and the deterministic insight block appended
 * by MentorInsightRenderer. The regression this guards is documented in modelProse.ts: an
 * assertion scored against the concatenated string can be satisfied by RepoGuide's own
 * correct graph output while the model's prose is entirely fabricated.
 */

test('modelProseOnly: returns the answer unchanged when no insight block was appended', () => {
    const answer = 'The `execute` method is called by `BaseAgent`.\n\nNothing else references it.';
    assert.equal(modelProseOnly(answer), answer);
});

test('modelProseOnly: cuts the Change Impact Analysis block', () => {
    const prose = 'Ten agents call `execute`.\n';
    const answer = `${prose}\n\n### Change Impact Analysis\n\n**Affected Symbols**\n- BaseAgent\n`;
    assert.equal(modelProseOnly(answer), prose + '\n\n');
});

test('modelProseOnly: cuts each of the four renderer headers', () => {
    for (const header of MENTOR_INSIGHT_HEADERS) {
        const answer = `model text\n\n${header}\n- appendix content`;
        assert.equal(modelProseOnly(answer), 'model text\n\n', `failed for ${header}`);
    }
});

test('modelProseOnly: cuts at the EARLIEST header when more than one appears', () => {
    const answer = 'prose\n\n### Change Impact Analysis\nx\n\n### Architecture Insights\ny';
    assert.equal(modelProseOnly(answer), 'prose\n\n');
});

test('modelProseOnly: a marker only present in the appendix is excluded from the prose', () => {
    // The exact adv-hot-3 shape: prose never names the real caller, appendix does.
    const answer = [
        '1. **PackagerAgent**: calls the `execute` method to package content.',
        '',
        '### Change Impact Analysis',
        '',
        '**Affected Symbols**',
        '- BaseAgent'
    ].join('\n');
    const prose = modelProseOnly(answer);
    assert.ok(answer.toLowerCase().includes('baseagent'), 'precondition: full answer contains the marker');
    assert.ok(!prose.toLowerCase().includes('baseagent'), 'prose must NOT inherit the appendix marker');
});

test('MENTOR_INSIGHT_HEADERS stays in sync with mentorInsightRenderer.ts', () => {
    // Guards the one way this module silently rots: a new insight block added to the
    // renderer would not be stripped here, silently reintroducing appendix contamination.
    // Resolved against the SOURCE tree (same convention as
    // src/test/webviews/gateStatusRendering.test.ts), since __dirname is out/test/evaluation
    // at runtime and only .js lives under out/.
    const rendererPath = path.join(__dirname, '../../../src/mentor/mentorInsightRenderer.ts');
    const source = fs.readFileSync(rendererPath, 'utf8');
    const emitted = [...source.matchAll(/lines\.push\('\\n\\n(### [^']+?)\\n'\)/g)].map(m => m[1]);
    assert.ok(emitted.length > 0, 'expected to find rendered section headers in the renderer source');
    assert.deepEqual(
        [...emitted].sort(),
        [...MENTOR_INSIGHT_HEADERS].sort(),
        'MENTOR_INSIGHT_HEADERS must list exactly the headers mentorInsightRenderer.ts emits'
    );
});
