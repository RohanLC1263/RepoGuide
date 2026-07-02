import { EvidencePlan, QueryType } from './query/evidencePlanTypes';
import { RepositoryBrainEvidenceStore } from './query/repositoryBrainEvidenceStore';
import * as path from 'path';

async function runTraces() {
    const store = new RepositoryBrainEvidenceStore(path.join(__dirname, '..', 'repository_brain.sqlite'));

    const queries = [
        {
            q: "Why did ADR-17 fail?",
            type: "causal_analysis",
            hints: ["ADR-17"]
        },
        {
            q: "Which ADRs succeeded?",
            type: "decision_outcome_analysis",
            hints: []
        },
        {
            q: "Which subsystem is most risky?",
            type: "hotspot_analysis",
            hints: []
        },
        {
            q: "What coverage regressions occurred recently?",
            type: "risk_analysis", // Mapping this to risk for now
            hints: []
        },
        {
            q: "What is the root cause of this hotspot?",
            type: "causal_analysis",
            hints: ["AuthModule"]
        },
        {
            q: "Which modules have dangerous coverage risk?",
            type: "risk_analysis",
            hints: []
        },
        {
            q: "Which architectural decisions are degrading?",
            type: "decision_outcome_analysis", // This will fetch all outcomes and we can sort
            hints: []
        },
        {
            q: "How does AuthService work?", // For Ranking check
            type: "architecture_analysis",
            hints: ["AuthService"]
        },
        {
            q: "Missing entity test", // For Failure mode check
            type: "causal_analysis",
            hints: ["MissingEntity-999"]
        }
    ];

    for (const q of queries) {
        console.log(`\n========================================`);
        console.log(`QUERY: ${q.q}`);
        const plan: EvidencePlan = {
            originalQuery: q.q,
            normalizedQuery: q.q,
            queryType: q.type as QueryType,
            requiredEvidence: [],
            symbolHints: q.hints,
            fileHints: [],
            factTypes: [],
            unitTypes: [],
            fileScope: 'both',
            retrievalStrategy: 'hybrid',
            mustExcludeRoles: [],
            diagnostics: [],
            confidence_mode: 'grounded'
        };

        console.log(`PLANNER: ${q.type}`);
        console.log(`EVIDENCE PLAN: symbolHints = [${q.hints.join(', ')}]`);

        const items = store.execute(plan);
        console.log(`RETURNED ITEMS: ${items.length}`);
        
        for (const item of items) {
            console.log(`  -> SCORE: ${item.score}`);
            console.log(`  -> CONTENT: ${item.content.replace(/\\n/g, '\n').split('\n')[0]} ...`);
        }
    }
}

runTraces().catch(console.error);
