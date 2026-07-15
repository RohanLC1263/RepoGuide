/**
 * Investigation-only script (Track 4 verification): runs a small batch of
 * real, hand-built, synthesis-requiring evidence packets (byte-accurate
 * content from CraftConnect, verified against the real files) through the
 * real EvidenceAnswerSynthesizer + AnswerGate, to check AnswerGate's
 * false-positive rate on a broader sample than the single GlobalState example.
 *
 * Usage: npm run compile && node out/evaluation/syntheticQuestionBatch.js
 */
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) },
        Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { EvidenceAnswerSynthesizer } from '../query/evidenceAnswerSynthesizer';
import { AnswerGate } from '../query/answerGate';
import { EvidencePacket } from '../query/evidencePacket';
import { getCraftConnectPath } from './craftconnectPath';

function basePlan(query: string): EvidencePacket['plan'] {
    return {
        originalQuery: query, normalizedQuery: '', queryType: 'architecture_analysis' as any,
        requiredEvidence: [], symbolHints: [], fileHints: [], factTypes: [], unitTypes: [],
        fileScope: 'workspace' as any, retrievalStrategy: 'hybrid' as any, mustExcludeRoles: [],
        diagnostics: [], confidence_mode: 'grounded'
    };
}

function packet(query: string, items: EvidencePacket['items']): EvidencePacket {
    return {
        query, plan: basePlan(query), items, facts: [], coverage: [], gaps: [],
        diagnostics: [], coverageScore: 1, matchedEvidenceTypes: []
    };
}

const scenarios: Array<{ name: string; packet: EvidencePacket }> = [
    {
        name: 'GlobalState singleton (from prior report)',
        packet: packet(
            'What does GlobalState in app/config.py do, and why is it a singleton instead of normal FastAPI dependency injection?',
            [
                { id: 'config-1', file: 'app/config.py', startLine: 1, endLine: 16, role: 'implementation', symbol: 'GlobalState', type: 'class', content: '"""\nGlobal State Management for CraftConnect\nHolds singleton instances to avoid circular dependencies.\n"""\nfrom typing import Optional, Any\n\nclass GlobalState:\n    _instance = None\n    orchestrator: Optional[Any] = None\n\n    def __new__(cls):\n        if cls._instance is None:\n            cls._instance = super(GlobalState, cls).__new__(cls)\n        return cls._instance\n\n# Global Singleton access\nglobal_state = GlobalState()', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'main-1', file: 'app/main.py', startLine: 52, endLine: 55, role: 'implementation', symbol: 'get_orchestrator', type: 'function', content: 'def get_orchestrator():\n    if global_state.orchestrator is None:\n        raise HTTPException(status_code=503, detail="System not ready")\n    return global_state.orchestrator', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'main-2', file: 'app/main.py', startLine: 128, endLine: 128, role: 'implementation', symbol: 'lifespan', type: 'function', content: '        global_state.orchestrator = orchestrator_instance\n        logging.info("MissionOrchestratorAgent initialized successfully")', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'main-3', file: 'app/main.py', startLine: 225, endLine: 225, role: 'implementation', symbol: 'orchestrator_agent', type: 'function', content: '    orchestrator_agent: Any = Depends(get_orchestrator) # Type: Any to avoid import', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' }
            ] as any
        )
    },
    {
        name: 'LLMRouter fallback order',
        packet: packet(
            'What is the actual fallback order when the primary LLM backend fails, and does it always start with Nova2?',
            [
                { id: 'router-1', file: 'app/llm_backends/llm_router.py', startLine: 160, endLine: 172, role: 'implementation', symbol: 'fallback_order', type: 'function', content: 'if self.backends["nova2"].is_available():\n    fallback_order.append("nova2")\n    logger.info(\n        "[LLMRouter] Nova2 available. "\n        "Using as primary backend."\n    )\nelse:\n    logger.warning(\n        "[LLMRouter] Nova2 unavailable. "\n        "Falling back to Groq as primary."\n    )', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'router-2', file: 'app/llm_backends/llm_router.py', startLine: 179, endLine: 186, role: 'implementation', symbol: 'fallback_order', type: 'function', content: 'fallback_order.extend([\n    "groq",\n    "gemini",\n    "ollama",\n    "mock"\n])', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'router-3', file: 'app/llm_backends/llm_router.py', startLine: 214, endLine: 222, role: 'implementation', symbol: 'select_backend', type: 'function', content: 'for backend_name in fallback_order:\n    if not self._is_in_cooldown(backend_name) and await self.backends[backend_name].health_check():\n        logger.info(f"Using {backend_name} backend")\n        return self.backends[backend_name], backend_name, None\n    else:\n        logger.warning(f"{backend_name} unavailable or in cooldown, trying next...")', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' }
            ] as any
        )
    },
    {
        name: 'AuthValidatorAgent threshold + review logic',
        packet: packet(
            'What determines whether AuthValidatorAgent flags a mission for human review?',
            [
                { id: 'auth-1', file: 'app/agents/auth_validator_agent.py', startLine: 86, endLine: 86, role: 'implementation', symbol: 'threshold', type: 'function', content: 'threshold = inputs.get("authenticity_threshold", self.DEFAULT_THRESHOLD)', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'auth-2', file: 'app/agents/auth_validator_agent.py', startLine: 103, endLine: 110, role: 'implementation', symbol: 'requires_human_review', type: 'function', content: 'authenticity_score = self._compute_authenticity_score(claim_results)\n\nrequires_human_review = (\n    authenticity_score < threshold or\n    any(r["status"] == ClaimStatus.CONFLICT for r in claim_results) or\n    any(r["status"] == ClaimStatus.NEEDS_REVIEW for r in claim_results)\n)', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' }
            ] as any
        )
    },
    {
        name: 'MissionOrchestratorAgent dependency injection container',
        packet: packet(
            'How does MissionOrchestratorAgent wire up its dependent agents?',
            [
                { id: 'mo-1', file: 'app/agents/mission_orchestrator.py', startLine: 1, endLine: 12, role: 'implementation', symbol: 'module docstring', type: 'class', content: '"""\nMission Orchestrator Agent - Phase 7 (Hardened & Modular)\n\nCoordinates the end-to-end pipeline:\nImage -> Classification -> RAG Retrieval -> Story Generation -> Mission Report\n\nRefactored to use MissionCoordinator, separating concerns into:\n- AgentContainer (Dependency Injection)\n- MissionCoordinator (Workflow Logic)\n- AuditLogger (State & Logging)\n- TTSService (Audio Generation)\n"""', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' },
                { id: 'mo-2', file: 'app/agents/mission_orchestrator.py', startLine: 32, endLine: 46, role: 'implementation', symbol: '__init__', type: 'function', content: 'def __init__(\n    self, \n    classifier_agent, \n    rag_agent, \n    story_agent,\n    packager_agent,\n    auth_validator_agent,\n    image_quality_agent=None,\n    artisan_trust_agent=None,\n    listing_assistant=None,\n    marketplace_agent=None, \n    market_agent=None,\n    visual_grounding_agent=None,\n    **kwargs', retrieval_signal: 'symbol_hint', score: 1, confidence: 1, extractionMethod: 'tree_sitter' }
            ] as any
        )
    }
];

async function main(): Promise<void> {
    const context = {
        workspaceRoot: getCraftConnectPath(),
        repoguideDataDir: path.join(getCraftConnectPath(), '.repoguide'),
        getConfig: <T,>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => p,
        logger: { appendLine: console.log, debug: console.log, info: console.log, warn: console.log, error: console.log, stageStart: () => {}, stageProgress: () => {}, stageComplete: () => {}, stageFailed: () => {}, artifactWritten: () => {}, queryLog: () => {}, repairLog: () => {} },
        notifyInfo: async () => {}, notifyWarning: async () => {}, notifyError: async () => {}
    };

    const synthesizer = new EvidenceAnswerSynthesizer(context as any);
    const gate = new AnswerGate();

    let blocked = 0;
    let passed = 0;
    let revised = 0;

    for (const scenario of scenarios) {
        console.log(`\n=== ${scenario.name} ===`);
        const answer = await synthesizer.synthesize(scenario.packet, 'qwen2.5-coder:7b', []);
        console.log(answer);
        const result = gate.verify(answer, scenario.packet, undefined, context.workspaceRoot);
        console.log(`\n[AnswerGate] outcome=${result.outcome}`);
        if (result.diagnostics.length > 0) {
            console.log('diagnostics:', JSON.stringify(result.diagnostics));
        }
        if (result.outcome === 'block') {blocked++;}
        else if (result.outcome === 'revise') {revised++;}
        else {passed++;}
    }

    console.log(`\n\n=== SUMMARY: ${passed} passed, ${revised} revised, ${blocked} blocked (out of ${scenarios.length}) ===`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
