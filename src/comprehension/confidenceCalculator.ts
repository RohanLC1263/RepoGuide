import { ContextQuality, ConfidenceFieldType } from './types';

export class ConfidenceCalculator {
  /**
   * Calculates the confidence score and provides a reasoning string based on the provided context quality.
   */
  public static calculateConfidence(
    contextQuality: ContextQuality | 'AST_DERIVED' | 'GRAPH_RESOLVED' | 'FALLBACK',
    fieldType: ConfidenceFieldType | string
  ): { confidence: number; reason: string } {
    const confidence = this.getBaseConfidence(contextQuality);
    const reason = this.getReason(contextQuality, fieldType);

    return { confidence, reason };
  }

  private static getBaseConfidence(quality: ContextQuality | 'AST_DERIVED' | 'GRAPH_RESOLVED' | 'FALLBACK'): number {
    switch (quality) {
      case 'AST_DERIVED':
        return 1.0;
      case 'GRAPH_RESOLVED':
        return 0.90;
      case 'FULL_CODE_WITH_GRAPH':
        return 0.85;
      case 'FULL_CODE_ONLY':
        return 0.80;
      case 'PARTIAL_CODE_WITH_GRAPH':
        return 0.65;
      case 'PARTIAL_CODE_ONLY':
        return 0.60;
      case 'METADATA_ONLY':
        return 0.50;
      case 'NONE':
        return 0.30;
      case 'FALLBACK':
      default:
        return 0.20;
    }
  }

  private static getReason(quality: ContextQuality | 'AST_DERIVED' | 'GRAPH_RESOLVED' | 'FALLBACK', fieldType: string): string {
    switch (quality) {
      case 'AST_DERIVED':
        return `Deterministically extracted from AST/tree-sitter for ${fieldType}.`;
      case 'GRAPH_RESOLVED':
        return `Deterministically resolved via import/call graph for ${fieldType}.`;
      case 'FULL_CODE_WITH_GRAPH':
        return `LLM inference using full source code and structural graph context for ${fieldType}.`;
      case 'FULL_CODE_ONLY':
        return `LLM inference using full source code without graph context for ${fieldType}.`;
      case 'PARTIAL_CODE_WITH_GRAPH':
        return `LLM inference using truncated source code and structural graph context for ${fieldType}.`;
      case 'PARTIAL_CODE_ONLY':
        return `LLM inference using truncated source code without graph context for ${fieldType}.`;
      case 'METADATA_ONLY':
        return `LLM inference using metadata only (no code body) for ${fieldType}.`;
      case 'NONE':
        return `No relevant context available; low confidence inference for ${fieldType}.`;
      case 'FALLBACK':
      default:
        return `Fallback/default value applied for ${fieldType}.`;
    }
  }
}
