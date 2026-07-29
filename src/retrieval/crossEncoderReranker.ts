import { EvidenceItem } from '../query/evidencePacket';

/**
 * Cross-encoder reranking of retrieved code context, between retrieval and packing.
 *
 * WHY HERE. Two already-diagnosed failures share one cause -- relevant evidence is
 * retrieved but does not survive to the model. The packer sorts by
 * `item.score + 0.75 * lexicalRelevance` and cuts to the context budget, so an item's
 * fate is decided by a retrieval score that never saw the question and a bag-of-words
 * overlap term. A cross-encoder reads (question, passage) together and is the standard
 * fix for exactly that ranking problem.
 *
 * WHY NOT bge-reranker-v2-m3, which was the model originally requested. It cannot run on
 * this stack, for three independent reasons: it is absent from the Ollama library, Ollama
 * 0.32.5 exposes no rerank endpoint (and its generate/chat/embed APIs cannot serve a
 * cross-encoder correctly in any case), and the HuggingFace repo ships no ONNX weights so
 * `@xenova/transformers` cannot load it either. Two ONNX cross-encoders that DO run on the
 * dependency this repo already has are offered instead, and which one ships is decided by
 * measurement rather than by benchmark table.
 *
 * RUNS ON CPU, COSTS ZERO VRAM. That is not incidental. The real machine has 8151 MiB
 * total with the 7B generator taking ~5.4 GB, leaving ~2.5 GB free -- there is no room for
 * a GPU-resident reranker, and `resetModelBeforeSynthesis` (on by default) means the
 * generator is unloaded and reloaded around every synthesis anyway.
 *
 * SCOPE: `items` only, never `facts`. Facts are AST-derived and deterministic -- the tier
 * this project trusts most. Letting a neural relevance model reorder them would put the
 * reliable tier at the mercy of the unreliable one.
 */

export type RerankerBackend = 'off' | 'bge' | 'minilm';

interface BackendSpec {
    model: string;
    label: string;
}

const BACKENDS: Record<Exclude<RerankerBackend, 'off'>, BackendSpec> = {
    // Same family as the originally-requested bge-reranker-v2-m3, ONNX-ready.
    bge: { model: 'Xenova/bge-reranker-base', label: 'bge-reranker-base' },
    // Lighter, faster, lower precision. The designated fallback.
    minilm: { model: 'Xenova/ms-marco-MiniLM-L-6-v2', label: 'ms-marco-MiniLM-L-6-v2' }
};

/**
 * How many top candidates to rescore. Cross-encoding is O(candidates) model calls, so the
 * whole point is to apply it to a shortlist rather than the full retrieval output. Items
 * beyond this keep their original score and stay ranked below the reranked block.
 */
const RERANK_CANDIDATE_LIMIT = 40;

/** Characters of an item's content shown to the cross-encoder. Beyond this adds latency without changing the ordering much. */
const PASSAGE_CHARS = 1200;

/**
 * Lowest score assigned to a reranked item. Everything the cross-encoder did NOT see is
 * compressed below this, so the two populations never interleave in the packer sort.
 */
const RERANK_FLOOR = 0.3;

/** Candidates scored per forward pass. */
const BATCH_SIZE = 8;

export interface RerankOutcome {
    reranked: number;
    skipped: number;
    durationMs: number;
    backend: string;
}

export class CrossEncoderReranker {
    private pipelinePromise: Promise<unknown> | null = null;
    private failed = false;

    constructor(
        private readonly backend: Exclude<RerankerBackend, 'off'>,
        private readonly log: (message: string) => void = () => { /* silent by default */ }
    ) {}

    get label(): string {
        return BACKENDS[this.backend].label;
    }

    /**
     * Loaded once, lazily, and shared. The first call pays a download on a cold cache;
     * afterwards it is a local ONNX session.
     */
    private async getPipeline(): Promise<{ tokenizer: any; model: any }> {
        if (!this.pipelinePromise) {
            const spec = BACKENDS[this.backend];
            this.pipelinePromise = (async () => {
                // Dynamic import: @xenova/transformers is ESM, matching the existing
                // LocalEmbeddingProvider pattern in src/memory/embeddings/.
                //
                // Tokenizer + model directly rather than the `text-classification`
                // pipeline, because that pipeline takes a single string: it has no way
                // to express the (query, passage) PAIR a cross-encoder exists to score.
                // Passing a pair to it fails with "text.split is not a function".
                // Going one level down is also what makes batching possible below.
                const transformers = await import('@xenova/transformers') as any;
                const [tokenizer, model] = await Promise.all([
                    transformers.AutoTokenizer.from_pretrained(spec.model),
                    transformers.AutoModelForSequenceClassification.from_pretrained(spec.model, { quantized: true })
                ]);
                return { tokenizer, model };
            })();
        }
        return this.pipelinePromise as Promise<{ tokenizer: any; model: any }>;
    }

    /**
     * Rewrites `score` on the top candidates from the cross-encoder's judgement.
     *
     * Rewriting the score rather than reordering the array is deliberate: the packer
     * re-sorts by `score + 0.75 * lexicalRelevance` regardless of input order, so a
     * reordered array alone would change nothing about what survives the budget cut.
     *
     * Mutates in place and returns telemetry. Never throws: a reranker that fails must
     * degrade to the existing ordering, not cost the user an answer.
     */
    async rerank(question: string, items: EvidenceItem[]): Promise<RerankOutcome> {
        const startedAt = Date.now();
        const outcome: RerankOutcome = { reranked: 0, skipped: items.length, durationMs: 0, backend: this.label };
        if (this.failed || items.length === 0) {
            outcome.durationMs = Date.now() - startedAt;
            return outcome;
        }

        try {
            const { tokenizer, model } = await this.getPipeline();
            const ranked = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const candidates = ranked.slice(0, RERANK_CANDIDATE_LIMIT);
            const remainder = ranked.slice(RERANK_CANDIDATE_LIMIT);

            // Batched: one forward pass per BATCH_SIZE candidates rather than one per
            // candidate. Chunked rather than a single giant batch so a long shortlist
            // cannot spike memory on a machine with very little headroom to spare.
            const logitsByIndex: number[] = [];
            for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
                const batch = candidates.slice(start, start + BATCH_SIZE);
                const passages = batch.map(item => `${item.file}\n${(item.content ?? "").slice(0, PASSAGE_CHARS)}`);
                const inputs = tokenizer(new Array(batch.length).fill(question), {
                    text_pair: passages,
                    padding: true,
                    truncation: true
                });
                const { logits } = await model(inputs);
                const raw = Array.from(logits.data as Float32Array) as number[];
                for (let i = 0; i < batch.length; i++) {
                    logitsByIndex.push(raw[i]);
                }
            }

            // NORMALISATION IS LOAD-BEARING, not cosmetic. The packer sorts by
            // `score + 0.75 * lexicalRelevance`, and a cross-encoder emits large negative
            // logits for almost everything -- measured, a correct top hit sigmoids to
            // ~0.002 while retrieval scores it competes against sit at 0.9-1.0. Written
            // through raw, the reranker would be swamped by the lexical term AND
            // outranked wholesale by any item beyond the shortlist that kept its original
            // score, i.e. it would be worse than useless. So the shortlist is spread
            // across [RERANK_FLOOR, 1] by relative order, and the unscored tail is
            // compressed below RERANK_FLOOR keeping its own relative order.
            const min = Math.min(...logitsByIndex);
            const max = Math.max(...logitsByIndex);
            const span = max - min;
            for (let i = 0; i < candidates.length; i++) {
                const relative = span > 1e-9 ? (logitsByIndex[i] - min) / span : 1;
                candidates[i].score = RERANK_FLOOR + relative * (1 - RERANK_FLOOR);
                outcome.reranked++;
            }
            const tailMax = Math.max(1e-9, ...remainder.map(item => item.score ?? 0));
            for (const item of remainder) {
                item.score = ((item.score ?? 0) / tailMax) * RERANK_FLOOR * 0.95;
            }
            outcome.skipped = remainder.length;
        } catch (e) {
            // One failure disables the reranker for this process rather than retrying a
            // broken model on every subsequent query.
            this.failed = true;
            this.log(`[Reranker] ${this.label} failed, falling back to retrieval order: ${e}`);
        }

        outcome.durationMs = Date.now() - startedAt;
        return outcome;
    }
}

/**
 * Both backends emit a single unbounded relevance logit per pair. A sigmoid puts them
 * on the [0,1] scale the packer's `score + 0.75 * lexicalRelevance` blend already
 * assumes, so neither backend needs special handling downstream.
 */
export function sigmoid(logit: number): number {
    return 1 / (1 + Math.exp(-logit));
}

/** Reads the configured backend, tolerating unknown values by disabling the feature. */
export function resolveRerankerBackend(value: string | undefined): RerankerBackend {
    return value === 'bge' || value === 'minilm' ? value : 'off';
}
