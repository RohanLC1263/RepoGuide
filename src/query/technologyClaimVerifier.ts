/**
 * Detects answers that assert the project USES a named technology/library/framework
 * that does not exist anywhere in the repository.
 *
 * Verified gap this closes: AnswerGate checks numeric claims, quoted strings, fenced
 * code blocks and file paths -- a bare technology noun in prose has no check at all.
 * Two documented instances both passed the gate completely clean:
 *   - "PDF generation uses an asynchronous task queue (e.g. Celery)" -- Celery appears
 *     nowhere in CraftConnect; generate_artisan_report_pdf is a plain sync function.
 *   - "the studio API exposes GraphQL resolvers" -- the API is REST/FastAPI.
 * Both are more dangerous than fabricated code, because there is no snippet or number
 * for any existing check to catch.
 *
 * PRECISION DESIGN. Two constraints drive this, both learned from earlier rounds where
 * an over-eager check had to be reverted:
 *  1. Only a CURATED list of well-known technology names is considered. Treating any
 *     capitalised word as a technology would flag ordinary domain nouns constantly.
 *  2. A name is only a fabrication if it is absent from the REPOSITORY, not merely
 *     absent from the retrieved packet -- a real dependency that simply was not
 *     retrieved for this question must never be reported as invented. The set of
 *     technologies actually present is resolved once against the search index and
 *     passed in, keeping AnswerGate.verify() synchronous.
 * Negated mentions ("does not use Celery", "there is no GraphQL layer") are never
 * flagged: denying a false premise is the CORRECT behaviour this exists to encourage.
 */

/** Well-known technologies worth checking. Absence of a name here means no check runs. */
export const KNOWN_TECHNOLOGY_TERMS: string[] = [
    'Celery', 'GraphQL', 'Redis', 'Kafka', 'RabbitMQ', 'Memcached', 'Elasticsearch',
    'MongoDB', 'Cassandra', 'DynamoDB', 'Kubernetes', 'Docker Swarm', 'Terraform',
    'WebSocket', 'gRPC', 'Django', 'Flask', 'Tornado', 'Sanic', 'Express',
    'NestJS', 'Angular', 'Vue', 'Svelte', 'Redux', 'MobX', 'GraphQL Federation',
    'Airflow', 'Luigi', 'Dagster', 'Spark', 'Hadoop', 'Flink',
    'RabbitMQ Streams', 'NATS', 'ZeroMQ', 'Sidekiq', 'Resque',
    'Prometheus', 'Grafana', 'Datadog', 'Sentry', 'OpenTelemetry',
    'Stripe', 'Twilio', 'SendGrid', 'Auth0', 'Okta', 'Keycloak'
];

/**
 * Affirmative "the project uses X" shapes. Deliberately requires a usage verb: a bare
 * mention ("unlike Celery, this is synchronous") is not an assertion of use.
 */
const USAGE_VERB = '(?:uses?|using|used|leverages?|relies\\s+on|is\\s+built\\s+(?:on|with)|is\\s+handled\\s+by|is\\s+managed\\s+by|runs?\\s+on|integrates?\\s+with|powered\\s+by|via|through|with)';

/** Negation/absence within the sentence -- denying the premise is correct, never flagged. */
const NEGATION_REGEX = /\b(?:not|no|never|n't|without|absent|does\s+not|doesn't|isn't|aren't|lacks?|there\s+is\s+no|nowhere|instead\s+of|rather\s+than|unlike)\b/i;

export interface TechnologyClaim {
    technology: string;
    sentence: string;
}

/**
 * Proximity window (chars) searched around a technology mention for a usage verb and
 * for negation. Deliberately NOT sentence-splitting: real answers are full of periods
 * that are not sentence ends -- "e.g. Celery", "i.e.", "auth.py", "version 3.11" --
 * and splitting on them separated "uses" from "Celery" in the very case this exists to
 * catch. A fixed window has no such failure mode.
 */
const PROXIMITY_WINDOW = 120;

/**
 * Finds affirmative claims that the project uses a given technology.
 * `presentTechnologies` are those confirmed to exist in the repository; anything in it
 * is never reported.
 */
export function detectFabricatedTechnologyClaims(
    answer: string,
    presentTechnologies: Set<string>
): TechnologyClaim[] {
    const found: TechnologyClaim[] = [];
    const presentLower = new Set(Array.from(presentTechnologies).map(t => t.toLowerCase()));
    const verbRegex = new RegExp(USAGE_VERB, 'i');

    for (const tech of KNOWN_TECHNOLOGY_TERMS) {
        if (presentLower.has(tech.toLowerCase())) {
            continue;
        }
        const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentions = new RegExp('\\b' + escaped + '\\b', 'gi');
        let m: RegExpExecArray | null;
        while ((m = mentions.exec(answer)) !== null) {
            const start = Math.max(0, m.index - PROXIMITY_WINDOW);
            const end = Math.min(answer.length, m.index + tech.length + PROXIMITY_WINDOW);
            const window = answer.slice(start, end);
            // Negation anywhere in the window means the answer is DENYING use, which is
            // the correct behaviour this check exists to encourage -- never flag it.
            if (NEGATION_REGEX.test(window)) {
                continue;
            }
            if (!verbRegex.test(window)) {
                continue; // a bare mention is not an assertion of use
            }
            found.push({ technology: tech, sentence: window.replace(/\s+/g, ' ').trim().slice(0, 160) });
            break; // report each technology once
        }
    }
    return found;
}

/** Text-index surface used to resolve which technologies really exist (satisfied by LogicalUnitBm25Store). */
export interface TechnologyPresenceLookup {
    search(query: string, maxResults: number): Promise<Array<{ filePath: string }>>;
}

/**
 * Resolves, once per process, which of the known technology terms actually appear in
 * the indexed repository. Cached because the answer is a property of the repo, not of
 * any single query, and it keeps verify() synchronous.
 */
export async function resolvePresentTechnologies(
    lookup: TechnologyPresenceLookup | undefined
): Promise<Set<string>> {
    const present = new Set<string>();
    if (!lookup) {
        // Without an index we cannot distinguish absent from unretrieved, so treat
        // every technology as present -- the check disables itself rather than risk
        // reporting a real dependency as invented.
        for (const t of KNOWN_TECHNOLOGY_TERMS) { present.add(t); }
        return present;
    }
    for (const tech of KNOWN_TECHNOLOGY_TERMS) {
        try {
            const hits = await lookup.search(tech, 1);
            if (hits.length > 0) { present.add(tech); }
        } catch {
            // A failed lookup must not manufacture a fabrication verdict.
            present.add(tech);
        }
    }
    return present;
}
