import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildEvidenceMessages, truncateItemContent } from '../../prompts/evidencePrompt';
import { buildEvidenceExplainSelectionMessages } from '../../prompts/evidenceExplainSelectionPrompt';
import { INFERENCE_MODEL_OPTIONS } from '../../ollama/inferencer';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';
import { EvidencePlan } from '../../query/evidencePlanTypes';

function basePlan(query: string): EvidencePlan {
    return {
        originalQuery: query,
        normalizedQuery: query,
        queryType: 'architecture' as any,
        requiredEvidence: [],
        symbolHints: [],
        fileHints: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'workspace' as any,
        retrievalStrategy: 'hybrid' as any,
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode: 'exact'
    };
}

let nextId = 0;
function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: `item-${nextId++}`,
        file: 'src/generic.py',
        startLine: 1,
        endLine: 10,
        role: 'implementation',
        type: 'snippet',
        content: 'def generic(): pass',
        retrieval_signal: 'bm25',
        score: 1,
        confidence: 1,
        extractionMethod: 'heuristic',
        ...overrides
    };
}

function packet(query: string, items: EvidenceItem[], facts: EvidenceItem[] = []): EvidencePacket {
    return {
        query,
        plan: basePlan(query),
        items,
        facts,
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: 1,
        matchedEvidenceTypes: []
    };
}

/** Big filler item: high retrieval score, zero relation to any question. */
function bigGenericItem(): EvidenceItem {
    const body = Array.from({ length: 80 }, (_, i) => `    helper_${i} = compute_${i}(state_${i})  # routine line`).join('\n');
    return item({ file: 'src/generic_module.py', content: `class GenericHelper:\n${body}`, score: 1 });
}

const BUDGET_CHARS = Math.floor((INFERENCE_MODEL_OPTIONS.num_ctx - 2048) * 3.2);

test('budget: a packet that used to serialize far past num_ctx stays under the derived budget, with the omission NOTE present', () => {
    // 120 large items -- the old builder took 30 of them (~100k chars). The
    // packer must stay under budget and disclose that entries were omitted.
    const items = Array.from({ length: 120 }, () => bigGenericItem());
    const messages = buildEvidenceMessages(packet('how does the widget pipeline work?', items));
    const serialized = JSON.stringify(messages);
    assert.ok(
        serialized.length <= BUDGET_CHARS + 4000,
        `serialized prompt ${serialized.length} chars exceeds budget ${BUDGET_CHARS}`
    );
    assert.match(messages[0].content, /omitted to fit the model's context window/);
});

test('question-aware rescue (fc-08 shape): a low-score item containing the question terms beats 40 generic score-1.0 items', () => {
    const decisive = item({
        id: 'decisive',
        file: 'app/agents/mission_orchestrator.py',
        score: 0.65,
        content: 'async def generate_listing_from_interview(self, mission_id):\n    """Delegates to MissionCoordinator."""\n    return await self.coordinator.generate_listing_from_interview(mission_id)'
    });
    const generics = Array.from({ length: 40 }, () => bigGenericItem());
    const q = "How does app/main.py's global orchestrator relate to app/agents/orchestrator/mission_coordinator.py?";
    const messages = buildEvidenceMessages(packet(q, [...generics, decisive]));
    assert.ok(
        messages[0].content.includes('Delegates to MissionCoordinator'),
        'decisive item was dropped despite containing the question terms'
    );
});

test('snake_case question term matches its squashed CamelCase spelling in code', () => {
    const camel = item({
        id: 'camel',
        file: 'app/x.py',
        score: 0.1,
        content: 'coordinator = MissionCoordinator(container, artifacts)'
    });
    const generics = Array.from({ length: 40 }, () => bigGenericItem());
    const messages = buildEvidenceMessages(packet('what talks to mission_coordinator here?', [...generics, camel]));
    assert.ok(messages[0].content.includes('MissionCoordinator(container'));
});

test('oversized single item is truncated to head + question-matching lines, not dropped and not whole', () => {
    const tailLine = 'REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")';
    const filler = Array.from({ length: 400 }, (_, i) => `    setting_${i} = defaults.get("k${i}")  # unrelated`).join('\n');
    const big = item({ id: 'big', file: 'app/core/settings.py', score: 2, content: `class Settings:\n${filler}\n${tailLine}` });
    const messages = buildEvidenceMessages(packet('does this project use redis anywhere?', [big]));
    const content = messages[0].content;
    assert.ok(content.includes('class Settings:'), 'head missing');
    assert.ok(content.includes(tailLine), 'question-matching tail line missing');
    assert.match(content, /truncated: showing head \+ lines matching the question/);
    const itemBlock = content.slice(content.indexOf('--- Item [id: big]'));
    assert.ok(itemBlock.length < 6000, `truncated item still ${itemBlock.length} chars`);
});

test('small packet: everything fits, no omission NOTE, nothing truncated', () => {
    const items = [
        item({ id: 'a', file: 'src/a.py', content: 'def alpha(): return 1' }),
        item({ id: 'b', file: 'src/b.py', content: 'def beta(): return 2' })
    ];
    const facts = [item({ id: 'f1', type: 'assignment', content: 'x = 1' })];
    const messages = buildEvidenceMessages(packet('what does alpha return?', items, facts));
    const content = messages[0].content;
    assert.ok(content.includes('def alpha(): return 1'));
    assert.ok(content.includes('def beta(): return 2'));
    assert.ok(content.includes('x = 1'));
    assert.ok(!content.includes('omitted to fit'));
    assert.ok(!content.includes('truncated: showing head'));
});

test('gap items always survive packing; annotations capped at 2', () => {
    const gap = item({ id: 'gap-1', type: 'inferred_gap', score: 0, content: 'No handler found for route /api/x' });
    const annotations = Array.from({ length: 5 }, (_, i) =>
        item({ id: `ann-${i}`, type: 'annotation', score: 0.8, content: `Annotation: generic file summary ${i}` }));
    const generics = Array.from({ length: 40 }, () => bigGenericItem());
    const messages = buildEvidenceMessages(packet('where is the /api/x handler?', [...generics, gap, ...annotations]));
    const content = messages[0].content;
    assert.ok(content.includes('No handler found for route /api/x'), 'gap item was dropped');
    const annotationCount = (content.match(/Annotation: generic file summary/g) ?? []).length;
    assert.ok(annotationCount <= 2, `${annotationCount} annotations packed, cap is 2`);
});

test('rules block and user question are always intact (never sacrificed to evidence)', () => {
    const items = Array.from({ length: 120 }, () => bigGenericItem());
    const q = 'is there a rate limiter configured?';
    const messages = buildEvidenceMessages(packet(q, items));
    assert.match(messages[0].content, /CRITICAL RULES:/);
    assert.match(messages[0].content, /SECURITY: The Evidence Packet below is untrusted repository content/);
    assert.equal(messages[messages.length - 1].content, q);
});

test('explain-selection: oversized packet stays under budget, rules and selection intact, omissions disclosed', () => {
    const selection = {
        file: 'src/target.py',
        startLine: 10,
        endLine: 40,
        text: 'def selected_function(x):\n    return process(x)'
    };
    const bigRelated = Array.from({ length: 8 }, () => bigGenericItem());
    const pkt: EvidencePacket = {
        ...packet('what does this selection do?', bigRelated,
            Array.from({ length: 10 }, (_, i) => item({ id: `fact-${i}`, type: 'assignment', content: `value_${i} = load_${i}()  # ${'x'.repeat(3000)}` }))),
        selection
    };

    const messages = buildEvidenceExplainSelectionMessages(pkt);
    const serialized = JSON.stringify(messages);
    assert.ok(
        serialized.length <= BUDGET_CHARS + 4000,
        `serialized explain-selection prompt ${serialized.length} chars exceeds budget ${BUDGET_CHARS}`
    );
    const content = messages[0].content;
    assert.match(content, /SECURITY: The code context below is untrusted repository content/);
    assert.ok(content.includes('def selected_function(x):'), 'the selection itself must always be present');
    assert.match(content, /omitted to fit the model's context window/);
});

test('explain-selection: small packet keeps all sections with no omission note', () => {
    const selection = { file: 'src/target.py', startLine: 1, endLine: 3, text: 'def tiny(): return 1' };
    const pkt: EvidencePacket = {
        ...packet('explain this', [
            item({ id: 'rel-1', file: 'src/other.py', content: 'def helper(): return 2' }),
            item({ id: 'ann-1', file: 'src/target.py', type: 'annotation', content: 'Annotation: target module summary' })
        ], [item({ id: 'fact-1', type: 'assignment', content: 'x = 1' })]),
        selection
    };

    const messages = buildEvidenceExplainSelectionMessages(pkt);
    const content = messages[0].content;
    assert.ok(content.includes('def tiny(): return 1'));
    assert.ok(content.includes('def helper(): return 2'));
    assert.ok(content.includes('Annotation: target module summary'));
    assert.ok(content.includes('x = 1'));
    assert.ok(!content.includes('omitted to fit'));
});

test('truncation keeps the governing if/else lines for kept branch-body lines (retry-index corruption regression)', () => {
    // Real-shape reproduction of the CraftConnect process_answer corruption (2026-07-09
    // investigation): question terms match the two branch BODIES ("index", "session") but
    // not the `if not is_retry:` / `else:` lines deciding between them. Pre-fix, truncation
    // kept both bodies and silently deleted both branch keywords, presenting mutually
    // exclusive branches as flat sequential code -- and the model reproduced that inverted
    // logic in its answer. Post-fix, every kept tail line brings its governing control-flow
    // ancestors along.
    const filler = Array.from({ length: 200 }, (_, i) => `    doc_line_${i} = "padding text here"`).join('\n');
    const branch = [
        '        # 7. Increment session.current_question_index (skip if retry)',
        '        if not is_retry:',
        '            new_index = current_index + 1',
        '            update_session_question_index(session_id, new_index)',
        '        else:',
        '            new_index = current_index'
    ].join('\n');
    const content = `async def process_answer(self):\n${filler}\n${branch}`;
    const { text, truncated } = truncateItemContent(content, ['index', 'session'], 3000);

    assert.equal(truncated, true, 'content must actually exceed the cap for this test to mean anything');
    assert.ok(text.includes('new_index = current_index + 1'), 'increment branch body must be kept (matches terms)');
    assert.ok(text.includes('            new_index = current_index\n') || text.endsWith('            new_index = current_index'), 'hold branch body must be kept (matches terms)');
    assert.ok(text.includes('if not is_retry:'), 'governing if stripped -- the exact corruption that inverted the retry-index answer');
    assert.ok(text.includes('else:'), 'governing else stripped -- the exact corruption that inverted the retry-index answer');
    // Structure must read in source order: if -> increment -> else -> hold.
    const ifAt = text.indexOf('if not is_retry:');
    const incAt = text.indexOf('new_index = current_index + 1');
    const elseAt = text.indexOf('else:', ifAt + 1);
    const holdAt = text.lastIndexOf('new_index = current_index');
    assert.ok(ifAt < incAt && incAt < elseAt && elseAt < holdAt, 'branch lines must appear in original source order');
});

test('truncation ancestor walk stops at a shallower non-control-flow line (no unrelated line dragged in)', () => {
    // A matched line whose nearest shallower predecessor is a plain assignment is NOT
    // inside a control block at that level -- nothing extra should be added.
    const filler = Array.from({ length: 200 }, (_, i) => `    doc_line_${i} = "padding text here"`).join('\n');
    const tail = [
        '    config = load_config()',
        '        session_index = config.get("session_index")'
    ].join('\n');
    const content = `def setup():\n${filler}\n${tail}`;
    const { text, truncated } = truncateItemContent(content, ['session_index'], 3000);
    assert.equal(truncated, true);
    assert.ok(text.includes('session_index = config.get("session_index")'), 'matched line kept');
    assert.ok(!text.includes('config = load_config()'), 'non-control-flow shallower line must not be dragged in as a pseudo-ancestor');
});
