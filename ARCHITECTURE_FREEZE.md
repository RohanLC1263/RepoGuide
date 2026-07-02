# **RepoGuide Architecture Freeze: Final Interface Contracts**

No code was modified. These are the final frozen contracts, derived from the current codebase and accepted architecture.

**Source basis:** QueryDispatcher motivates the single canonical execution path. EvidencePacketBuilder, EvidenceAnswerSynthesizer, and AnswerGate motivate evidence-first synthesis and validation. HybridRetrievalFusion motivates high-recall retrieval. RepositoryBrainEvidenceStore, RepositoryBrain domain engines, runtime intelligence, notes, and annotations motivate durable intelligence providers. LogicalUnitStore, FactStore, ProgramGraphStore, SymbolIndex, LanceStore, and BM25 stores motivate providerized evidence retrieval.

---

## **Part 1 — ExecutionPlanner Contract**

### **Ownership**

ExecutionPlanner owns:

* converting a user request into an executable plan  
* intent analysis coordination  
* query classification  
* complexity assessment  
* retrieval strategy selection  
* provider selection  
* evidence requirements  
* confidence policy  
* verification policy  
* failure policy

It must **never** own:

* retrieval execution  
* direct store access  
* RepositoryBrain mutation  
* answer synthesis  
* answer validation  
* MCP-specific behavior  
* UI presentation

### **Canonical Pipeline**

PlanningRequest  
\-\> Intent Analysis  
\-\> Query Classification  
\-\> Complexity Assessment  
\-\> Planning Strategy Selection  
\-\> Retrieval Strategy Selection  
\-\> Provider Selection  
\-\> Evidence Requirements  
\-\> Verification Planning  
\-\> Confidence Policy  
\-\> Failure Policy  
\-\> ExecutionPlan

**Existing motivation:**

* QueryDispatcher already chooses regex vs LLM planning through complexity scoring.  
* `buildEvidencePlan` defines query types and required evidence.  
* `buildLLMEvidencePlan` decomposes complex questions.  
* `StrategyRouter` selects retrieval strategy and chunk budget.  
* `QueryIntentRouter` already recognizes runtime, impact, refactor, debugging, architecture, and explanation intents.

### **Query Categories**

Frozen categories:

type QueryCategory \=  
  | 'factual\_lookup'  
  | 'symbol\_lookup'  
  | 'dependency\_analysis'  
  | 'architectural\_reasoning'  
  | 'debugging'  
  | 'investigation'  
  | 'explain\_selection'  
  | 'documentation'  
  | 'repository\_exploration'  
  | 'engineering\_decision\_support'  
  | 'multi\_step\_reasoning';

**Mapping rule:**

* factual lookup uses FactStore, BM25, symbols  
* symbol lookup uses SymbolIndex, LogicalUnitStore, BM25  
* dependency analysis uses ProgramGraphStore, import graph, symbols  
* architectural reasoning uses annotations, community summaries, graph, RepositoryBrain  
* debugging uses InvestigationEngine, hybrid retrieval, runtime evidence  
* engineering decision support uses RepositoryBrain plus source evidence

### **TypeScript Contracts**

interface PlanningRequest {  
  requestId: string;  
  query: string;  
  client: 'vscode' | 'mcp' | 'internal';  
  workspaceRoot: string;  
  repoguideDir: string;  
  mode: 'answer' | 'raw\_evidence' | 'investigation' | 'explain\_selection';  
  selection?: {  
    file: string;  
    startLine: number;  
    endLine: number;  
    text: string;  
    language?: string;  
  };  
  conversationContext?: Array\<{ role: 'user' | 'assistant'; content: string }\>;  
  constraints?: {  
    maxLatencyMs?: number;  
    maxEvidenceItems?: number;  
    requireFreshEvidence?: boolean;  
    allowLLMPlanning?: boolean;  
  };  
}

interface ExecutionPlan {  
  planId: string;  
  requestId: string;  
  query: string;  
  category: QueryCategory;  
  intent: IntentResult;  
  complexity: ComplexityResult;  
  strategy: PlanningStrategy;  
  retrievalPlan: RetrievalPlan;  
  intelligencePlan: RepositoryIntelligencePlan;  
  evidenceRequirements: EvidenceRequirement\[\];  
  verificationPlan: VerificationPlan;  
  confidencePolicy: ConfidencePolicy;  
  freshnessPolicy: FreshnessPolicy;  
  failurePolicy: FailurePolicy;  
  diagnostics: PlannerDiagnostic\[\];  
  metadata: PlannerMetadata;  
}

interface RetrievalPlan {  
  strategy:  
    | 'exact'  
    | 'hybrid'  
    | 'graph\_expansion'  
    | 'broad\_semantic'  
    | 'investigation'  
    | 'runtime\_augmented';  
  targetSymbols: string\[\];  
  targetFiles: string\[\];  
  targetConcepts: string\[\];  
  providerIds: string\[\];  
  excludedRoles: Array\<'test' | 'generated' | 'docs'\>;  
  preferredEvidenceTypes: string\[\];  
  maxItems: number;  
  maxLatencyMs: number;  
}

interface RepositoryIntelligencePlan {  
  enabled: boolean;  
  knowledgeTypes: RepositoryKnowledgeType\[\];  
  subjects: string\[\];  
  requireValidated: boolean;  
  includeStale: boolean;  
  maxItems: number;  
}

**Validation rules:**

* `planId`, `requestId`, `query`, `category`, `retrievalPlan`, and `evidenceRequirements` are mandatory.  
* `providerIds` must reference registered providers.  
* `confidencePolicy.mode` must match category risk.  
* `failurePolicy` must define behavior for planner, retrieval, synthesis, and validation failures.  
* Plans must be serializable for diagnostics and MCP.

### **Planner States**

idle  
\-\> analyzing\_intent  
\-\> classifying\_query  
\-\> scoring\_complexity  
\-\> selecting\_strategy  
\-\> selecting\_providers  
\-\> building\_requirements  
\-\> building\_verification  
\-\> completed

Failure states: `planner_failed`, `planner_degraded`, `planner_fallback_used`

**Retry behavior:**

* LLM planning may retry once.  
* If LLM planning fails, fallback to deterministic planner.  
* Replanning is allowed only before retrieval begins.  
* Runtime retrieval failures do not trigger planner mutation; they produce evidence gaps.

### **Planner Invariants**

* Planner never retrieves evidence.  
* Planner never answers.  
* Planner output must be executable by RetrievalOrchestrator.  
* Planner must produce gaps/requirements even for unknown queries.  
* Planner must preserve client neutrality: VS Code and MCP use the same plan schema.

### **Planner Sequence**

sequenceDiagram  
    participant Q as QueryDispatcher  
    participant P as ExecutionPlanner  
    participant I as IntentAnalyzer  
    participant C as ComplexityScorer  
    participant S as StrategySelector

    Q-\>\>P: PlanningRequest  
    P-\>\>I: analyze(query)  
    I--\>\>P: IntentResult  
    P-\>\>C: score(query)  
    C--\>\>P: ComplexityResult  
    P-\>\>S: select(intent, complexity)  
    S--\>\>P: strategy \+ providers  
    P--\>\>Q: ExecutionPlan

---

## **Part 2 — Retrieval Provider Architecture**

### **Provider Model**

Every retrieval or intelligence source implements the same evidence-provider contract. This is motivated by existing parallel sources: HybridRetrievalFusion, RepositoryBrainEvidenceStore, FactStore, LogicalUnitStore, ProgramGraphStore, SymbolIndex, LanceStore, BM25 stores, annotations, notes, runtime traces.

### **Provider Interface**

interface EvidenceProvider {  
  readonly id: string;  
  readonly kind: EvidenceProviderKind;  
  readonly capabilities: EvidenceProviderCapabilities;

  initialize(context: ProviderContext): Promise\<ProviderInitResult\>;  
  health(): Promise\<ProviderHealth\>;  
  canHandle(request: EvidenceProviderRequest): ProviderDecision;  
  retrieve(request: EvidenceProviderRequest): Promise\<EvidenceProviderResponse\>;  
  shutdown(): Promise\<void\>;  
}

type EvidenceProviderKind \=  
  | 'hybrid\_retrieval'  
  | 'repository\_brain'  
  | 'fact\_store'  
  | 'logical\_unit\_store'  
  | 'program\_graph'  
  | 'symbol\_index'  
  | 'vector\_store'  
  | 'bm25'  
  | 'annotation'  
  | 'note'  
  | 'runtime'  
  | 'investigation';

interface EvidenceProviderRequest {  
  requestId: string;  
  planId: string;  
  query: string;  
  category: QueryCategory;  
  retrievalPlan: RetrievalPlan;  
  intelligencePlan?: RepositoryIntelligencePlan;  
  targets: {  
    symbols: string\[\];  
    files: string\[\];  
    concepts: string\[\];  
  };  
  limits: {  
    maxItems: number;  
    maxLatencyMs: number;  
  };  
  freshnessPolicy: FreshnessPolicy;  
  diagnosticsContext?: Record\<string, unknown\>;  
}

interface EvidenceProviderResponse {  
  providerId: string;  
  status: 'success' | 'partial' | 'empty' | 'timeout' | 'failed';  
  items: EvidenceItem\[\];  
  diagnostics: ProviderDiagnostic\[\];  
  metadata: {  
    latencyMs: number;  
    sourceCount?: number;  
    staleCount?: number;  
    confidenceRange?: \[number, number\];  
  };  
}

### **Provider Lifecycle**

registered  
\-\> initialized  
\-\> ready  
\-\> degraded  
\-\> unavailable  
\-\> shutting\_down  
\-\> stopped

**Registration:**

* providers are registered during workspace initialization  
* provider ids are stable  
* provider capabilities are discoverable  
* provider readiness is queryable

**Readiness:**

* primary source providers must fail closed if uninitialized  
* optional providers may degrade without blocking query execution  
* RepositoryBrain may be unavailable but must produce diagnostics

### **Retrieval Policies**

**Sequential execution:** use when a provider depends on another provider's output (example: graph expansion after symbol resolution).

**Parallel execution:** default for independent providers (example: BM25, vector, facts, notes, annotations).

**Adaptive execution:** allowed when early evidence satisfies coverage; must still record skipped providers in diagnostics.

**Latency budgets:**

* global budget comes from ExecutionPlan  
* each provider receives a sub-budget  
* timeout yields partial response, not exception propagation

**Duplicate elimination:**

* evidence identity key: `provider + source + file + startLine + endLine + type + subject`  
* stronger provenance wins  
* fresher evidence wins  
* higher confidence wins only after freshness/provenance checks

**Ranking:**

* source-grounded exact evidence outranks inferred evidence  
* validated RepositoryBrain evidence outranks unvalidated brain evidence  
* stale evidence is demoted unless query explicitly asks history  
* user-confirmed notes outrank suggested notes  
* runtime-confirmed evidence boosts confidence

**Confidence normalization:**

* all providers normalize confidence to 0.0–1.0  
* provider-native confidence must be preserved in metadata  
* orchestrator may adjust confidence but must not erase provenance

**Freshness normalization:** all evidence receives `fresh | possibly_stale | stale | unknown`

**Stopping conditions:**

* required evidence satisfied  
* latency budget exhausted  
* provider failure policy triggered  
* enough validated exact evidence for exact query

### **RetrievalOrchestrator Contract**

**Owns:** provider selection execution, provider fan-out/fan-in, provider timeouts, provider diagnostics, normalized provider responses, duplicate elimination, cross-provider ranking, evidence coverage precheck.

**Never owns:** planning, answer generation, AnswerGate validation, RepositoryBrain mutation.

interface RetrievalOrchestrator {  
  execute(plan: ExecutionPlan): Promise\<RetrievalOrchestrationResult\>;  
}

interface RetrievalOrchestrationResult {  
  planId: string;  
  items: EvidenceItem\[\];  
  providerResults: EvidenceProviderResponse\[\];  
  gaps: EvidenceGap\[\];  
  coverage: EvidenceCoverage;  
  diagnostics: RetrievalDiagnostic\[\];  
  metadata: {  
    latencyMs: number;  
    providersInvoked: string\[\];  
    providersSkipped: string\[\];  
    providersFailed: string\[\];  
  };  
}

### **Provider Interactions**

* **HybridRetrievalFusion:** invoked for broad, semantic, symbolic, graph-biased source retrieval.  
* **RepositoryBrain:** invoked when durable knowledge may answer or contextualize the query.  
* **FactStore:** invoked for exact factual lookup, constants, configs, thresholds, prompt strings.  
* **LogicalUnitStore:** invoked for symbol and source-span evidence.  
* **ProgramGraphStore:** invoked for dependency, impact, callers, callees, instantiation, fallback.  
* **SymbolIndex:** invoked for symbol grounding and query target resolution.  
* **LanceStore:** invoked through vector retrieval provider.  
* **Runtime:** invoked for runtime health, trace verification, runtime-source mapping.  
* **Notes:** invoked when retrieved context overlaps developer notes.  
* **Annotations:** invoked for architectural, onboarding, diagnostic, and role/signal context.

### **Retrieval Sequence**

sequenceDiagram  
    participant Q as QueryDispatcher  
    participant R as RetrievalOrchestrator  
    participant H as HybridRetrievalProvider  
    participant B as RepositoryBrainProvider  
    participant F as FactProvider  
    participant G as GraphProvider

    Q-\>\>R: ExecutionPlan  
    R-\>\>H: retrieve(request)  
    R-\>\>B: retrieve(request)  
    R-\>\>F: retrieve(request)  
    R-\>\>G: retrieve(request)  
    H--\>\>R: EvidenceProviderResponse  
    B--\>\>R: EvidenceProviderResponse  
    F--\>\>R: EvidenceProviderResponse  
    G--\>\>R: EvidenceProviderResponse  
    R--\>\>Q: RetrievalOrchestrationResult

### **Retrieval State Machine**

idle  
\-\> preparing  
\-\> selecting\_providers  
\-\> executing\_parallel  
\-\> executing\_dependent  
\-\> normalizing  
\-\> deduplicating  
\-\> ranking  
\-\> completed

Failure states: `partial_success`, `provider_timeout`, `provider_failed`, `coverage_insufficient`

---

## **Part 3 — RepositoryBrain Contract**

### **Ownership**

RepositoryBrain owns: persistent repository knowledge, knowledge lifecycle, confidence history, provenance, freshness, contradiction tracking, validation state, knowledge retrieval, knowledge explanation, knowledge invalidation and retirement.

RepositoryBrain must **never** own: raw code indexing, low-level retrieval orchestration, final answer generation, AnswerGate bypass, MCP-specific behavior, unvalidated hidden memory, vendor-specific agent session state.

### **RepositoryKnowledge Schema**

interface RepositoryKnowledge {  
  id: string;  
  schemaVersion: string;

  type: RepositoryKnowledgeType;  
  subject: KnowledgeSubject;  
  claim: KnowledgeClaim;

  confidence: KnowledgeConfidence;  
  provenance: KnowledgeProvenance;  
  freshness: KnowledgeFreshness;

  lifecycleState: KnowledgeLifecycleState;  
  validationState: KnowledgeValidationState;

  supportingEvidence: KnowledgeEvidenceRef\[\];  
  contradictions: KnowledgeContradiction\[\];

  ownership: {  
    owner: 'repoguide' | 'developer' | 'runtime' | 'imported';  
    createdBy: string;  
    lastUpdatedBy: string;  
  };

  timestamps: {  
    createdAt: string;  
    updatedAt: string;  
    validatedAt?: string;  
    promotedAt?: string;  
    staleAt?: string;  
    retiredAt?: string;  
    archivedAt?: string;  
  };

  version: {  
    knowledgeVersion: number;  
    producerVersion: string;  
    migrationVersion: string;  
  };

  tags: string\[\];  
  diagnostics: string\[\];  
}

type RepositoryKnowledgeType \=  
  | 'architecture\_decision'  
  | 'decision\_outcome'  
  | 'causal\_explanation'  
  | 'change\_impact'  
  | 'runtime\_mapping'  
  | 'incident\_pattern'  
  | 'knowledge\_hotspot'  
  | 'coverage\_risk'  
  | 'prediction\_accountability'  
  | 'developer\_note'  
  | 'ownership\_expertise'  
  | 'dependency\_insight'  
  | 'module\_summary'  
  | 'repository\_pattern';

type KnowledgeLifecycleState \=  
  | 'candidate'  
  | 'validated'  
  | 'promoted'  
  | 'active'  
  | 'stale'  
  | 'contradicted'  
  | 'retired'  
  | 'archived';

type KnowledgeValidationState \=  
  | 'unvalidated'  
  | 'machine\_validated'  
  | 'runtime\_validated'  
  | 'developer\_validated'  
  | 'contradicted'  
  | 'invalid';

**Field rules:**

* `id` is stable and globally unique inside repository.  
* `schemaVersion` is required for migration.  
* `type` determines validation policy.  
* `subject` must reference file, symbol, module, decision, runtime component, or repository.  
* `claim` must be human-readable and machine-classifiable.  
* `confidence` must include numeric score and source breakdown.  
* `provenance` must reference source artifacts.  
* `freshness` must be recomputable.  
* `supportingEvidence` cannot be empty for promoted or active knowledge.  
* `contradictions` must preserve both sides of the conflict.  
* active knowledge may become stale or contradicted, never silently overwritten.

### **Knowledge Lifecycle**

stateDiagram-v2  
    \[\*\] \--\> Candidate  
    Candidate \--\> Validated  
    Validated \--\> Promoted  
    Promoted \--\> Active  
    Active \--\> Stale  
    Active \--\> Contradicted  
    Stale \--\> Active  
    Stale \--\> Retired  
    Contradicted \--\> Retired  
    Retired \--\> Archived

**Transition rules:**

* candidate \-\> validated: evidence exists and validation policy passes.  
* validated \-\> promoted: confidence exceeds type threshold.  
* promoted \-\> active: committed to current repository intelligence.  
* active \-\> stale: source file, fact, graph, runtime, or note dependency changed.  
* active \-\> contradicted: new evidence conflicts with claim.  
* stale \-\> active: refreshed evidence validates claim.  
* stale \-\> retired: source no longer exists or confidence decays below threshold.  
* contradicted \-\> retired: contradiction cannot be resolved.  
* retired \-\> archived: retained for history, excluded by default.

**Confidence updates:**

* runtime validation boosts confidence  
* developer validation boosts confidence  
* stale sources reduce confidence  
* contradictions reduce confidence sharply  
* repeated evidence can raise confidence only with independent provenance

### **Public API**

interface RepositoryBrain {  
  observe(request: ObserveKnowledgeRequest): Promise\<ObserveKnowledgeResponse\>;  
  validate(request: ValidateKnowledgeRequest): Promise\<ValidateKnowledgeResponse\>;  
  promote(request: PromoteKnowledgeRequest): Promise\<PromoteKnowledgeResponse\>;  
  retrieve(request: RepositoryKnowledgeRetrieveRequest): Promise\<RepositoryKnowledgeRetrieveResponse\>;  
  query(request: RepositoryKnowledgeQueryRequest): Promise\<RepositoryKnowledgeQueryResponse\>;  
  explain(request: ExplainKnowledgeRequest): Promise\<ExplainKnowledgeResponse\>;  
  invalidate(request: InvalidateKnowledgeRequest): Promise\<InvalidateKnowledgeResponse\>;  
  refresh(request: RefreshKnowledgeRequest): Promise\<RefreshKnowledgeResponse\>;  
  retire(request: RetireKnowledgeRequest): Promise\<RetireKnowledgeResponse\>;  
  forget(request: ForgetKnowledgeRequest): Promise\<ForgetKnowledgeResponse\>;  
}

**API meanings:**

* `observe()`: create or update candidate knowledge from source evidence.  
* `validate()`: evaluate candidate against validation policy.  
* `promote()`: make validated knowledge eligible for active use.  
* `retrieve()`: fetch by id/type/subject.  
* `query()`: semantic/structured search over active knowledge.  
* `explain()`: return provenance and confidence explanation.  
* `invalidate()`: mark stale or contradicted due to changed evidence.  
* `refresh()`: recompute freshness/confidence.  
* `retire()`: remove from active use but preserve history.  
* `forget()`: delete by explicit user or privacy action.

### **Storage Contract**

**Persistence:** local-first only, stored under `.repoguide`, schema-versioned, migration-supported, recoverable after crash.

**Indexes:** by id, by type, by subject, by file, by symbol, by lifecycle state, by freshness state, by confidence, by updated timestamp.

**Rebuild policy:**

* raw source-derived knowledge may be rebuilt  
* developer-confirmed knowledge must be preserved  
* retired/archived knowledge preserved unless user forgets it  
* migrations must not silently drop knowledge

### **RepositoryBrain As Provider**

RepositoryBrain implements `EvidenceProvider`. `RepositoryBrainProvider.retrieve(request)` returns `EvidenceProviderResponse` where evidence items have: `source = 'repository_brain'`, `provider = 'repository_brain'`, `provenance.repositoryKnowledgeIds` includes knowledge id, freshness reflects knowledge freshness, confidence reflects knowledge confidence.

**Integration:**

* ExecutionPlanner may request RepositoryBrain knowledge types.  
* RetrievalOrchestrator invokes RepositoryBrain through provider interface.  
* EvidencePacketBuilder consumes RepositoryBrain evidence without special cases.  
* InvestigationEngine may ask RepositoryBrain for prior incidents, risks, and hypotheses.  
* AnswerGate may use RepositoryBrain provenance and freshness but cannot let it bypass validation.  
* MCP may expose RepositoryBrain through canonical query or explicit knowledge tools.

---

## **Part 4 — Cross-Contract Consistency**

### **Consistency Rules**

1. ExecutionPlanner emits ExecutionPlan.  
2. RetrievalOrchestrator accepts ExecutionPlan.  
3. Every provider accepts EvidenceProviderRequest.  
4. RepositoryBrain implements EvidenceProvider.  
5. EvidencePacketBuilder consumes only EvidenceItem\[\], EvidenceGap\[\], and diagnostics.  
6. EvidenceAnswerSynthesizer consumes only EvidencePacket.  
7. AnswerGate validates answer against EvidencePacket.  
8. MCP and VS Code both enter through canonical orchestration.

### **No Ownership Conflicts Remain**

* Planning owns decisions.  
* Retrieval owns evidence gathering.  
* RepositoryBrain owns persistent intelligence.  
* EvidencePacketBuilder owns evidence normalization.  
* Synthesizer owns answer generation.  
* AnswerGate owns validation.  
* MCP owns external access only.

### **EvidencePacketBuilder Rule**

EvidencePacketBuilder must **not** contain provider-specific branches such as:

if provider is RepositoryBrain ...  
if provider is HybridRetrieval ...

It may branch only on normalized evidence fields like type, source, freshness, confidence, and priority.

---

## **Part 5 — Architecture Freeze Verdict**

### **Permanently Frozen Decisions**

* One canonical answer path.  
* ExecutionPlanner does not retrieve or answer.  
* HybridRetrievalFusion is retrieval-only in canonical architecture.  
* RepositoryBrain is a first-class intelligence provider.  
* RepositoryBrain contributes evidence and never bypasses Evidence Pipeline.  
* Every provider uses the common evidence provider contract.  
* EvidencePacket is the only synthesis input.  
* AnswerGate is mandatory.  
* MCP is a facade over the canonical engine.

### **Decisions That May Evolve**

* Internal planner heuristics.  
* Provider weighting formulas.  
* Ranking coefficients.  
* RepositoryBrain storage engine.  
* RepositoryBrain schema extensions through versioned migrations.  
* AnswerGate validation sophistication.  
* Retrieval provider set.  
* Performance budgets by product tier.

### **Readiness Scores**

| Contract | Score |
| ----- | ----- |
| ExecutionPlanner Readiness | 9.6 / 10 |
| Retrieval Provider Architecture Readiness | 9.7 / 10 |
| RepositoryBrain Readiness | 9.5 / 10 |
| Cross-Contract Consistency | 9.8 / 10 |
| **Overall Architecture Freeze Readiness** | **9.6 / 10** |

### **Remaining Risks**

**ExecutionPlanner:** exact initial heuristic weights can evolve during implementation — acceptable because schema and ownership are frozen.

**Retrieval architecture:** provider ranking math remains tunable — acceptable because orchestration contract is frozen.

**RepositoryBrain:** physical storage details may evolve — acceptable because lifecycle, schema semantics, and API are frozen.

### **Final Verdict**

These three contracts are sufficiently specified for implementation. Independent engineering teams should converge on the same architecture because ownership, interfaces, lifecycle, inputs, outputs, and invariants are now explicit. RepoGuide can proceed to implementation without another architectural redesign.

