import * as assert from 'assert';
import { buildAnswerProvenance, buildAnswerSourceInventory } from '../query/answerProvenance';
import { FileAnnotation } from '../comprehension/fileAnnotationEngine';
import { CommunitySummary } from '../comprehension/communityClustering';
import { CodeChunk } from '../store/storeTypes';
import { FusedChunk } from '../query/hybridRetrievalFusion';

function chunk(filePath: string, startLine: number, endLine: number, text: string): CodeChunk {
    return {
        id: `${filePath}:${startLine}`,
        filePath,
        language: 'javascript',
        startLine,
        endLine,
        text,
        vector: [],
        hash: 'hash'
    };
}

const retrieved: FusedChunk[] = [
    {
        chunk: chunk(
            'eval_repos/axios/lib/core/Axios.js',
            20,
            80,
            'class Axios { request(configOrUrl, config) { return dispatchRequest(config); } }'
        ),
        score: 1,
        rank: 1
    }
];

const annotations: FileAnnotation[] = [
    {
        file: 'eval_repos/axios/lib/core/Axios.js',
        hash: 'hash1',
        generated_at: new Date().toISOString(),
        confidence: 'high',
        what: 'Defines the central Axios class and request orchestration methods.',
        role: 'service',
        key_symbols: ['Axios', 'request'],
        depends_on: ['dispatchRequest'],
        signals: ['async_pattern']
    }
];

const communities: CommunitySummary[] = [
    {
        id: 'axios-core',
        name: 'Axios Core',
        central_file: 'eval_repos/axios/lib/core/Axios.js',
        files: ['eval_repos/axios/lib/core/Axios.js', 'eval_repos/axios/lib/core/dispatchRequest.js'],
        summary: 'Core request orchestration around Axios and dispatchRequest.',
        generated_at: new Date().toISOString()
    }
];

const sources = buildAnswerSourceInventory({
    chunks: retrieved,
    annotations,
    communities
});

const locationAnswer = [
    'Axios is defined in eval_repos/axios/lib/core/Axios.js, where the Axios class implements request orchestration.',
    'Axios uses quantum sockets to teleport retries between adapters.'
].join(' ');
const locationProvenance = buildAnswerProvenance('location-smoke', locationAnswer, sources);

assert.ok(
    locationProvenance.claims.some(claim =>
        claim.source_type === 'direct_code' &&
        claim.file === 'eval_repos/axios/lib/core/Axios.js'
    ),
    'location answer should emit at least one direct_code claim'
);
assert.ok(
    locationProvenance.unsupported_claims.some(claim =>
        claim.claim_text.includes('quantum sockets') &&
        claim.source_type === 'inferred'
    ),
    'unsupported content should be marked inferred, not direct_code'
);
assert.equal(
    locationProvenance.stale_sources.length,
    0,
    'stale source list should be explicitly empty when no stale data is known'
);

const orientationAnswer = 'RepoGuide analysis indicates Axios Core provides core request orchestration around Axios and dispatchRequest.';
const orientationProvenance = buildAnswerProvenance('orientation-smoke', orientationAnswer, sources);

if (annotations.length > 0 || communities.length > 0) {
    assert.ok(
        orientationProvenance.claims.some(claim =>
            claim.source_type === 'community_summary' || claim.source_type === 'annotation'
        ),
        'orientation answer should emit annotation or community_summary evidence when artifacts exist'
    );
}

const staleSources = sources.map(source =>
    source.source_type === 'annotation'
        ? { ...source, is_stale: true }
        : source
);
const staleProvenance = buildAnswerProvenance(
    'stale-smoke',
    'The Axios annotation says it defines the central Axios class and request orchestration methods.',
    staleSources
);
assert.ok(
    staleProvenance.claims.some(claim => claim.source_type === 'annotation' && claim.is_stale),
    'claims aligned to stale sources should be marked stale'
);
assert.ok(
    staleProvenance.stale_sources.some(source => source.source_type === 'annotation'),
    'stale source inventory should include stale annotation source'
);

console.log('Provenance backend smoke PASS');
console.log(JSON.stringify({
    location_claims: locationProvenance.claims,
    orientation_claims: orientationProvenance.claims,
    stale_sources: staleProvenance.stale_sources
}, null, 2));
