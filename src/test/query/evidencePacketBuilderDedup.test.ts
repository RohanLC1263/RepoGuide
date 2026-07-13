import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FactStore } from '../../store/factStore';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { LogicalUnitBm25Store } from '../../store/logicalUnitBm25Store';
import { EvidencePacketBuilder } from '../../query/evidencePacketBuilder';
import { buildEvidencePlan } from '../../query/evidencePlanner';
import { FactRecord } from '../../indexing/factTypes';

/**
 * Induced-failure regression test for EvidencePacketBuilder's own copy of the
 * unit-axis duplicate-fact bug (the same one FactStoreProvider had, commit
 * 424540c5). Confirmed live against CraftConnect's real facts.db: buildPacket
 * carried 122-144 true-duplicate fact groups in a 502-fact packet, because
 * addItem keys factsMap on item.id (= factId, which embeds unitId), so the
 * same source line extracted once per enclosing unit (class + method) survived
 * as separate entries. Built from the exact real 4-row confidence_threshold
 * shape.
 *
 * Confirmed a real induced failure: removing the dedupeFactItems() call at the
 * packet.facts assignment makes this test fail (the fact appears twice per type).
 */

async function makeTempRepo(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function confidenceThresholdRows(): FactRecord[] {
    const base = {
        filePath: 'app/agents/customization_interview_agent.py',
        symbol: 'self.confidence_threshold',
        value: 0.55,
        valueKind: 'number' as const,
        startLine: 65,
        endLine: 65,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        sourceText: 'self.confidence_threshold = 0.55',
        role: 'implementation' as const
    };
    const classUnit = 'app/agents/customization_interview_agent.py::CustomizationInterviewAgent::class::51';
    const methodUnit = 'app/agents/customization_interview_agent.py::__init__::method::62';
    return [
        { ...base, factId: 'ct-assign-class', unitId: classUnit, factType: 'assignment' },
        { ...base, factId: 'ct-assign-method', unitId: methodUnit, factType: 'assignment' },
        { ...base, factId: 'ct-thresh-method', unitId: methodUnit, factType: 'numeric_threshold' },
        { ...base, factId: 'ct-thresh-class', unitId: classUnit, factType: 'numeric_threshold' }
    ];
}

async function buildPacketForQuery(query: string, rows: FactRecord[]) {
    const repoRoot = await makeTempRepo('epb-dedup');
    const factStore = new FactStore(path.join(repoRoot, '.repoguide'));
    await factStore.init(repoRoot);
    await factStore.upsertFacts(rows);
    const unitStore = new LogicalUnitStore(path.join(repoRoot, '.repoguide'));
    await unitStore.init(repoRoot);
    const bm25 = new LogicalUnitBm25Store(path.join(repoRoot, '.repoguide'));
    await bm25.init();

    const builder = new EvidencePacketBuilder({ unitStore, factStore, bm25Store: bm25 }, repoRoot);
    const plan = buildEvidencePlan(query);
    return builder.buildPacket(query, plan);
}

test('buildPacket collapses unit-axis duplicate facts to one per type -- the real confidence_threshold 4->2 case', async () => {
    const packet = await buildPacketForQuery('confidence_threshold', confidenceThresholdRows());

    const ct = packet.facts.filter(f => f.symbol === 'self.confidence_threshold');
    const types = ct.map(f => f.type).sort();
    assert.deepEqual(
        types,
        ['assignment', 'numeric_threshold'],
        `expected exactly one fact per type (assignment + numeric_threshold), got: ${ct.map(f => f.type).join(', ')}`
    );
});

test('buildPacket keeps two value-distinct facts on the same file/line/symbol/type (value is part of the dedup key)', async () => {
    // The real mission_coordinator.py:51 case: two distinct call_sites on one line.
    const base = {
        filePath: 'app/agents/orchestrator/mission_coordinator.py',
        symbol: 'MissionCoordinator',
        valueKind: 'string' as const,
        startLine: 51,
        endLine: 51,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        factType: 'call_site' as const,
        role: 'implementation' as const
    };
    const rows: FactRecord[] = [
        { ...base, factId: 'call-a', unitId: 'u1', value: 'str(uuid4())', sourceText: 'str(uuid4())' },
        { ...base, factId: 'call-b', unitId: 'u1', value: 'uuid4()', sourceText: 'uuid4()' }
    ];
    const packet = await buildPacketForQuery('MissionCoordinator', rows);

    const calls = packet.facts.filter(f => f.symbol === 'MissionCoordinator' && f.type === 'call_site');
    const contents = calls.map(f => f.content).sort();
    assert.deepEqual(contents, ['str(uuid4())', 'uuid4()'], 'both value-distinct call_sites must survive dedup');
});

test('buildPacket does not over-merge the same symbol in two different files (basename collision)', async () => {
    const base = {
        symbol: 'TOAST_LIMIT',
        factType: 'numeric_threshold' as const,
        value: 1,
        valueKind: 'number' as const,
        startLine: 8,
        endLine: 8,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        sourceText: 'const TOAST_LIMIT = 1',
        role: 'implementation' as const
    };
    const rows: FactRecord[] = [
        { ...base, factId: 'tl-ui', unitId: 'u1', filePath: 'components/ui/use-toast.ts' },
        { ...base, factId: 'tl-hooks', unitId: 'u2', filePath: 'hooks/use-toast.ts' }
    ];
    const packet = await buildPacketForQuery('TOAST_LIMIT', rows);

    const files = packet.facts.filter(f => f.symbol === 'TOAST_LIMIT').map(f => f.file).sort();
    assert.deepEqual(files, ['components/ui/use-toast.ts', 'hooks/use-toast.ts'], 'same symbol in two files must not be merged');
});
