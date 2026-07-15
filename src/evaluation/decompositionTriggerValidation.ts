/**
 * Trigger-rate validation for query decomposition (investigation tooling): runs
 * the REAL trigger chain -- deterministic complexity scorer + real LLM planner
 * (with sub-question emission + validation) + decompositionEligible() -- over
 * the full rc-01..rc-12 and fc-01..fc-12 dogfood batches, and reports exactly
 * which questions would decompose and why/why not. The feature must fire on
 * genuinely multi-facet questions and stay quiet on everything else; this
 * measures that on the 24 real questions this thread has been testing with,
 * not on synthetic examples the thresholds were shaped against.
 *
 * Usage: npm run compile && node out/evaluation/decompositionTriggerValidation.js
 */
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { scoreQueryComplexity } from '../query/planning/complexityScorer';
import { buildLLMEvidencePlan } from '../query/planning/llmEvidencePlanner';
import { decompositionEligible, DECOMPOSITION_MIN_COMPLEXITY_SCORE } from '../query/queryDispatcher';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { RepositoryContext } from '../context/repositoryContext';
import { getProfile } from '../config/performanceConfig';
import { getCraftConnectPath } from './craftconnectPath';

const QUESTIONS: Array<{ id: string; question: string; expectation: 'single-shot' | 'decompose' | 'either' }> = [
    // rc batch -- realistic single-topic questions; expectation: none should decompose
    { id: 'rc-01', question: "What happens when a user uploads an image to start a new mission -- walk me through the full request path from HTTP endpoint to database record?", expectation: 'either' },
    { id: 'rc-02', question: "If execute_mission in mission_service.py raises an exception while running the orchestrator, what actually gets stored in the database, and does the user ever see the raw error message?", expectation: 'either' },
    { id: 'rc-03', question: "Is app/core/community_engine.py actually used anywhere in the running app, or is it dead code left over from an earlier version?", expectation: 'single-shot' },
    { id: 'rc-04', question: "What rate limit does the /api/auth/me endpoint enforce, and what happens when a client exceeds it?", expectation: 'single-shot' },
    { id: 'rc-05', question: "The ObservabilityMiddleware sets an X-Request-ID for every request. Is that request ID used anywhere else in the codebase beyond logging, or does it just get logged and discarded?", expectation: 'single-shot' },
    { id: 'rc-06', question: "Why does interview_db.py store its default questions in Hindi and Kannada alongside English -- is this multi-language feature actually reachable from any API endpoint?", expectation: 'single-shot' },
    { id: 'rc-07', question: "In mission_service.execute_mission, what's the idempotency mechanism, and what happens if two requests for the same mission_id arrive at nearly the same time?", expectation: 'single-shot' },
    { id: 'rc-08', question: "What does FLAG_THRESHOLD control in this codebase, and where does its value actually get read and enforced?", expectation: 'single-shot' },
    { id: 'rc-09', question: "Does the /api/auth/verify endpoint's verify_token function do anything beyond what the get_current_user dependency it depends on already does?", expectation: 'single-shot' },
    { id: 'rc-10', question: "What's the actual difference between app/orchestrator/ and app/agents/mission_orchestrator.py -- which one runs in production?", expectation: 'single-shot' },
    { id: 'rc-11', question: "Does CraftConnect use Firestore or Supabase for its database -- or both, and under what conditions does it pick one over the other?", expectation: 'single-shot' },
    { id: 'rc-12', question: "Trace what happens to the local temp image file after a mission completes in mission_service.py -- is it ever cleaned up?", expectation: 'single-shot' },
    // fc batch
    { id: 'fc-01', question: "Walk me through what happens when a client calls DELETE /api/missions -- does it remove every mission for that user, and what happens to the uploaded files already on disk?", expectation: 'either' },
    { id: 'fc-02', question: "What enforces the lock after a mission is sealed via POST /api/mission/{id}/seal -- can a sealed mission still be edited, and if so how is that prevented or allowed?", expectation: 'single-shot' },
    { id: 'fc-03', question: "Is app/core/community_engine.py actually wired into the running app, or is it something else entirely?", expectation: 'single-shot' },
    { id: 'fc-04', question: "What's the real difference between app/agents/rag_retriever_agent.py and app/agents/rag_retrieval_engine.py -- is one of them dead code?", expectation: 'single-shot' },
    { id: 'fc-05', question: "Is app/agents/mission_orchestrator.backup.py still used by anything in the running app?", expectation: 'single-shot' },
    { id: 'fc-06', question: "Does CraftConnect use Redis anywhere, and if so, what is it actually used for?", expectation: 'single-shot' },
    { id: 'fc-07', question: "What's the JWT/JWKS signing-key refresh mechanism in this codebase, and does it actually run as part of the live app?", expectation: 'single-shot' },
    { id: 'fc-08', question: "How does app/main.py's global orchestrator relate to app/agents/orchestrator/mission_coordinator.py -- are they the same thing, competing implementations, or does one wrap the other?", expectation: 'single-shot' },
    { id: 'fc-09', question: "When studio_write.py's generate_listing_from_interview endpoint runs, does it reach the same orchestrator used for mission creation, or a separate code path?", expectation: 'single-shot' },
    { id: 'fc-10', question: "Does CraftConnect expose a GraphQL API anywhere in the codebase?", expectation: 'single-shot' },
    { id: 'fc-11', question: "Is Stripe or any other payment processor integrated into this codebase?", expectation: 'single-shot' },
    { id: 'fc-12', question: "Does this codebase use WebSockets anywhere for real-time communication?", expectation: 'single-shot' },
    // the hypothesis-test master -- the one question KNOWN to deserve decomposition
    { id: 'master', question: 'Walk me through the complete mission execution pipeline in this codebase: starting from mission_service.execute_mission, which agents run and in what order, how per-agent failures and timeouts are handled, and where the final mission report ends up on disk and in the database.', expectation: 'decompose' }
];

function fakeContext(workspaceRoot: string): RepositoryContext {
    return {
        workspaceRoot,
        getConfig: <T,>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
            stageStart: () => undefined, stageProgress: () => undefined, stageComplete: () => undefined, stageFailed: () => undefined,
            artifactWritten: () => undefined, queryLog: () => undefined, repairLog: () => undefined
        },
        notifyInfo: async () => undefined, notifyWarning: async () => undefined, notifyError: async () => undefined
    };
}

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(getCraftConnectPath());
    const context = fakeContext(workspaceRoot);
    const model = getProfile().inferenceModel;
    const unitStore = new LogicalUnitStore(path.join(workspaceRoot, '.repoguide'));
    await unitStore.init(workspaceRoot);

    let fired = 0;
    const rows: string[] = [];
    for (const q of QUESTIONS) {
        const complexity = scoreQueryComplexity(q.question);
        // The real trigger chain: LLM planner only runs for complex-classified queries
        // (same condition ExecutionPlanner uses); simple ones can never decompose.
        let queryType = '(regex planner -- no sub-questions possible)';
        let subCount = 0;
        let subQuestions: string[] = [];
        let taskDescriptions: string[] = [];
        if (complexity.classification === 'complex') {
            const plan = await buildLLMEvidencePlan(context, q.question, model, [], unitStore);
            queryType = plan.queryType;
            subQuestions = plan.subQuestions ?? [];
            subCount = subQuestions.length;
            taskDescriptions = (plan.retrievalTasks ?? []).map(t => t.description ?? '').filter(Boolean);
        }
        const decomposes = decompositionEligible(complexity.score, queryType, subQuestions);
        if (decomposes) { fired++; }
        const verdictMark = q.expectation === 'either'
            ? 'OK(either)'
            : (decomposes ? 'decompose' : 'single-shot') === q.expectation ? 'OK' : 'MISMATCH';
        rows.push(`${q.id}: score=${complexity.score} type=${queryType} subs=${subCount} tasks=${taskDescriptions.length} -> ${decomposes ? 'DECOMPOSE' : 'single-shot'} [expected ${q.expectation}: ${verdictMark}]`);
        for (const sub of subQuestions) {
            rows.push(`    sub: ${sub}`);
        }
        for (const desc of taskDescriptions) {
            rows.push(`    task: ${desc}`);
        }
        console.log(rows.filter(r => r.startsWith(q.id)).join('\n'));
    }

    console.log('\n================ SUMMARY ================');
    for (const row of rows) { console.log(row); }
    console.log(`\nTrigger rate: ${fired}/${QUESTIONS.length} (threshold=${DECOMPOSITION_MIN_COMPLEXITY_SCORE})`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
