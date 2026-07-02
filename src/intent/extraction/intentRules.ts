import { IntentType } from './intentTypes';

export interface IntentRule {
    pattern: RegExp;
    type: IntentType;
    canonicalTopic: string;
}

export const INTENT_RULES: IntentRule[] = [
    // SECURITY
    { pattern: /\b(oauth2?|jwt|auth(enticat(e|ion))?|login|token)\b/i, type: "SECURITY", canonicalTopic: "Authentication" },
    { pattern: /\b(authoriz(e|ation)|rbac|permissions?|acls?)\b/i, type: "SECURITY", canonicalTopic: "Authorization" },
    { pattern: /\b(pci|compliance|gdpr|hipaa)\b/i, type: "SECURITY", canonicalTopic: "PCI Compliance" },
    { pattern: /\b(encrypt(ion)?|cryptography|aes|rsa|cipher)\b/i, type: "SECURITY", canonicalTopic: "Encryption" },
    { pattern: /\b(vulnerabilit(y|ies)|cve|xss|csrf|sqli|injection)\b/i, type: "SECURITY", canonicalTopic: "Vulnerability Management" },

    // PERFORMANCE
    { pattern: /\b(cach(e|ing)|redis|memcached)\b/i, type: "PERFORMANCE", canonicalTopic: "Caching" },
    { pattern: /\b(latenc(y|ies)|response time)\b/i, type: "PERFORMANCE", canonicalTopic: "Latency Reduction" },
    { pattern: /\b(throughput|qps|rps)\b/i, type: "PERFORMANCE", canonicalTopic: "Throughput Optimization" },
    { pattern: /\b(optimiz(e|ation)|bottleneck|profiling)\b/i, type: "PERFORMANCE", canonicalTopic: "Performance Optimization" },

    // RELIABILITY
    { pattern: /\b(retry|retries|backoff)\b/i, type: "RELIABILITY", canonicalTopic: "Retry Logic" },
    { pattern: /\b(fault(\s|-)toleran(ce|t)|resilien(ce|t)|failover)\b/i, type: "RELIABILITY", canonicalTopic: "Fault Tolerance" },
    { pattern: /\b(circuit(\s|-)breaker)\b/i, type: "RELIABILITY", canonicalTopic: "Circuit Breaker" },

    // SCALABILITY
    { pattern: /\b(scal(e|ing)|horizontally?|vertically?)\b/i, type: "SCALABILITY", canonicalTopic: "Scaling Strategy" },
    { pattern: /\b(partition(ing)?|shard(ing)?)\b/i, type: "SCALABILITY", canonicalTopic: "Data Partitioning" },

    // ARCHITECTURE
    { pattern: /\b(microservices?|monolith(ic)?|service(\s|-)oriented)\b/i, type: "ARCHITECTURE", canonicalTopic: "System Architecture" },
    { pattern: /\b(event(\s|-)driven|pub(\/|-)sub|message(\s|-)bus)\b/i, type: "ARCHITECTURE", canonicalTopic: "Event-Driven Architecture" },

    // MIGRATION
    { pattern: /\b(migrat(e|ion))\b/i, type: "MIGRATION", canonicalTopic: "Migration" },
    { pattern: /\b(deprecat(e|ion|ed)|sunsetting)\b/i, type: "MIGRATION", canonicalTopic: "Deprecation" },

    // TECHNICAL_DEBT
    { pattern: /\b(refactor(ing)?|cleanup|technical(\s|-)debt)\b/i, type: "TECHNICAL_DEBT", canonicalTopic: "Refactoring" },
    
    // OBSERVABILITY
    { pattern: /\b(log(ging)?|trace|tracing|metric(s)?|monitor(ing)?|datadog|prometheus|grafana|telemetry)\b/i, type: "OBSERVABILITY", canonicalTopic: "Observability" }
];
