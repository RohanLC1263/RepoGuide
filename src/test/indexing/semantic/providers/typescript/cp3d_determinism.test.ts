import * as assert from 'assert';
import { ObservationAccumulator } from '../../../../../indexing/semantic/providers/typescript/resolution/observationAccumulator';
import { RelationshipDescriptor } from '../../../../../indexing/semantic/providers/typescript/internalModels';
import { RepositoryRelationshipAssembler } from '../../../../../indexing/semantic/providers/typescript/repositoryRelationshipAssembler';

describe('CP3D Determinism', () => {
    const mockDescriptor1: RelationshipDescriptor = {
        relationshipKind: 'CALLS',
        source: { package: '', logicalNamespace: '', qualifiedName: 'A', symbolKind: 'function', signatureHash: 'h1', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        target: { package: '', logicalNamespace: '', qualifiedName: 'B', symbolKind: 'function', signatureHash: 'h2', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        location: { filePath: 'test.ts', startLine: 10, endLine: 10 }
    };

    const mockDescriptor2: RelationshipDescriptor = {
        relationshipKind: 'CALLS',
        source: { package: '', logicalNamespace: '', qualifiedName: 'A', symbolKind: 'function', signatureHash: 'h1', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        target: { package: '', logicalNamespace: '', qualifiedName: 'B', symbolKind: 'function', signatureHash: 'h2', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        location: { filePath: 'test.ts', startLine: 20, endLine: 20 }
    };

    const mockDescriptor3: RelationshipDescriptor = {
        relationshipKind: 'CALLS',
        source: { package: '', logicalNamespace: '', qualifiedName: 'C', symbolKind: 'function', signatureHash: 'h3', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        target: { package: '', logicalNamespace: '', qualifiedName: 'D', symbolKind: 'function', signatureHash: 'h4', identityOrigin: 'Repository', identityAuthority: 'compiler' },
        location: { filePath: 'other.ts', startLine: 5, endLine: 5 }
    };

    it('observation accumulation consolidates duplicates into one edge', () => {
        const accumulator = new ObservationAccumulator();
        accumulator.accumulate(mockDescriptor1);
        accumulator.accumulate(mockDescriptor2);

        const aggregates = accumulator.getAggregates();
        assert.strictEqual(aggregates.length, 1);
        assert.strictEqual(aggregates[0].evidence.length, 2);
        
        assert.strictEqual(aggregates[0].evidence[0].location?.startLine, 10);
        assert.strictEqual(aggregates[0].evidence[1].location?.startLine, 20);
    });

    it('reverse insertion produces byte-for-byte identical output', () => {
        const accumulator1 = new ObservationAccumulator();
        accumulator1.accumulate(mockDescriptor1);
        accumulator1.accumulate(mockDescriptor2);
        accumulator1.accumulate(mockDescriptor3);
        const out1 = JSON.stringify(accumulator1.getAggregates());

        const accumulator2 = new ObservationAccumulator();
        accumulator2.accumulate(mockDescriptor3);
        accumulator2.accumulate(mockDescriptor2);
        accumulator2.accumulate(mockDescriptor1);
        const out2 = JSON.stringify(accumulator2.getAggregates());

        assert.strictEqual(out1, out2); 
    });

    it('duplicate observations are ignored (idempotent accumulation)', () => {
        const accumulator = new ObservationAccumulator();
        accumulator.accumulate(mockDescriptor1);
        accumulator.accumulate(mockDescriptor1);
        accumulator.accumulate(mockDescriptor1);

        const aggregates = accumulator.getAggregates();
        assert.strictEqual(aggregates.length, 1);
        assert.strictEqual(aggregates[0].evidence.length, 1);
    });

    it('RepositoryRelationshipAssembler derives structural category for DECLARES', () => {
        const assembler = new RepositoryRelationshipAssembler();
        const aggregate = {
            identity: { relationshipKind: 'DECLARES' as any, sourceHash: 's', targetHash: 't' },
            source: mockDescriptor1.source,
            target: mockDescriptor1.target,
            evidence: []
        };
        const rel = assembler.assemble(aggregate);
        assert.strictEqual(rel.category, 'structural');
    });
});
