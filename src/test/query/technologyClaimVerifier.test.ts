import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    detectFabricatedTechnologyClaims,
    resolvePresentTechnologies,
    KNOWN_TECHNOLOGY_TERMS
} from '../../query/technologyClaimVerifier';

/**
 * Bare technology nouns in prose previously had NO gate coverage at all. Both
 * documented instances passed clean: "PDF generation uses an asynchronous task queue
 * (e.g. Celery)" and "the studio API exposes GraphQL resolvers", naming technologies
 * absent from the whole repository.
 */

const PRESENT_NONE = new Set<string>();
const PRESENT_REDIS = new Set(['Redis']);

test('flags a usage claim naming a technology absent from the repository (the Celery case)', () => {
    const found = detectFabricatedTechnologyClaims(
        'The PDF generation uses an asynchronous task queue (e.g. Celery) to run in the background.',
        PRESENT_NONE
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].technology, 'Celery');
});

test('flags the GraphQL case', () => {
    const found = detectFabricatedTechnologyClaims(
        'The studio API is built with GraphQL resolvers for listing drafts.',
        PRESENT_NONE
    );
    assert.ok(found.some(f => f.technology === 'GraphQL'));
});

test('does NOT flag a technology that really exists in the repository', () => {
    const found = detectFabricatedTechnologyClaims(
        'Session state is handled by Redis for caching.',
        PRESENT_REDIS
    );
    assert.deepEqual(found, []);
});

test('does NOT flag a NEGATED mention -- denying a false premise is the correct behaviour', () => {
    for (const sentence of [
        'The project does not use Celery; PDF generation is synchronous.',
        'There is no GraphQL layer in this codebase.',
        'Rather than Kafka, it writes directly to the database.',
        "It doesn't rely on Redis for this."
    ]) {
        assert.deepEqual(detectFabricatedTechnologyClaims(sentence, PRESENT_NONE), [], sentence);
    }
});

test('does NOT flag a bare mention with no usage verb', () => {
    const found = detectFabricatedTechnologyClaims(
        'Celery is a popular task queue in the Python ecosystem.',
        PRESENT_NONE
    );
    assert.deepEqual(found, []);
});

test('detects the reversed order ("X handles the export") as well as "uses X"', () => {
    const found = detectFabricatedTechnologyClaims(
        'Kafka is used to stream the mission events.',
        PRESENT_NONE
    );
    assert.ok(found.some(f => f.technology === 'Kafka'));
});

test('reports each technology once even when mentioned repeatedly', () => {
    const found = detectFabricatedTechnologyClaims(
        'It uses Celery for exports. The Celery worker is configured separately. Celery runs on a queue.',
        PRESENT_NONE
    );
    assert.equal(found.filter(f => f.technology === 'Celery').length, 1);
});

test('resolvePresentTechnologies: with no index, disables the check rather than risk false accusations', async () => {
    const present = await resolvePresentTechnologies(undefined);
    assert.equal(present.size, KNOWN_TECHNOLOGY_TERMS.length, 'every term treated as present => nothing can be flagged');
});

test('resolvePresentTechnologies: marks only terms the index actually finds', async () => {
    const lookup = {
        search: async (q: string) => (q === 'Redis' ? [{ filePath: 'app/core/cache.py' }] : [])
    };
    const present = await resolvePresentTechnologies(lookup);
    assert.ok(present.has('Redis'));
    assert.ok(!present.has('Celery'));
});

test('resolvePresentTechnologies: a failing lookup never manufactures a fabrication verdict', async () => {
    const lookup = { search: async () => { throw new Error('index down'); } };
    const present = await resolvePresentTechnologies(lookup);
    assert.ok(present.has('Celery'), 'lookup failure must be treated as present, not absent');
});

// --- AnswerGate integration ---------------------------------------------------
// The detector above is pure; these prove the GATE actually acts on it. Needed
// because a live run cannot force the model to fabricate on demand -- in the
// adversarial suite the model produced correct denials, so the check never fired
// there and integration would otherwise be unverified.
import { AnswerGate } from '../../query/answerGate';
import { EvidencePacket } from '../../query/evidencePacket';

function gatePacket(): EvidencePacket {
    return {
        query: 'how is the pdf generated', plan: { confidence_mode: 'grounded', requiredEvidence: [] } as never,
        items: [{
            id: 'i1', file: 'app/services/pdf_generator.py', startLine: 249, endLine: 260,
            role: 'implementation' as never, type: 'function', content: 'def generate_artisan_report_pdf(...)',
            retrieval_signal: 'lance_store', score: 0.9, confidence: 1, extractionMethod: 'tree_sitter' as never
        }],
        facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: []
    };
}

test('AnswerGate BLOCKS an answer asserting a technology absent from the repository', () => {
    const gate = new AnswerGate();
    const answer = 'PDF generation uses an asynchronous task queue (e.g. Celery) so the request returns immediately.';
    const r = gate.verify(answer, gatePacket(), undefined, '/ws', undefined, new Set());
    assert.equal(r.outcome, 'block');
    assert.ok(r.unsupported_claims.some(c => /Celery/.test(c) && /does not appear anywhere/.test(c)));
});

test('AnswerGate does NOT block when the technology really exists in the repository', () => {
    const gate = new AnswerGate();
    const answer = 'Session state is handled by Redis.';
    const r = gate.verify(answer, gatePacket(), undefined, '/ws', undefined, new Set(['Redis']));
    assert.notEqual(r.outcome, 'block');
});

test('AnswerGate does NOT block a correct DENIAL of a false premise (the adv-fp-2 shape)', () => {
    const gate = new AnswerGate();
    const answer = 'The evidence does not determine which Celery task queue handles the PDF export; it does not mention Celery at all.';
    const r = gate.verify(answer, gatePacket(), undefined, '/ws', undefined, new Set());
    assert.notEqual(r.outcome, 'block');
});

test('AnswerGate check is inert when presentTechnologies is not supplied (backward compatible)', () => {
    const gate = new AnswerGate();
    const answer = 'PDF generation uses Celery to run in the background.';
    const r = gate.verify(answer, gatePacket(), undefined, '/ws');
    assert.notEqual(r.outcome, 'block');
});
