import Parser = require('node-tree-sitter');
import { receiverTypeName } from '../astHelpers';

/**
 * Scope-based name lookup replacing a real compiler -- Go has no
 * embeddable equivalent, so resolution here is confined to same-file
 * declarations only: package-level types (for composite-literal
 * INSTANTIATES / embedded-field EXTENDS), package-level functions, and
 * methods grouped by their receiver's type name (for CALLS). Go doesn't
 * support overloading, so a name should never legitimately collide here,
 * but candidates are still tracked as lists and resolved only when
 * unambiguous, for the same defensive reason Java's/C#'s resolvers do --
 * a real language limitation isn't a reason to skip a cheap safety net.
 */
export class GoNameResolver {
    private topLevelTypes = new Map<string, Parser.SyntaxNode>();
    private topLevelFunctions = new Map<string, Parser.SyntaxNode[]>();
    private methodsByType = new Map<string, Map<string, Parser.SyntaxNode[]>>();

    constructor(root: Parser.SyntaxNode) {
        for (const child of root.namedChildren) {
            if (child.type === 'type_declaration') {
                for (const spec of child.namedChildren) {
                    if (spec.type !== 'type_spec') continue;
                    const name = spec.childForFieldName('name')?.text;
                    const typeNode = spec.childForFieldName('type');
                    if (name && (typeNode?.type === 'struct_type' || typeNode?.type === 'interface_type')) {
                        this.topLevelTypes.set(name, spec);
                    }
                }
            } else if (child.type === 'function_declaration') {
                const name = child.childForFieldName('name')?.text;
                if (name) {
                    this.addCandidate(this.topLevelFunctions, name, child);
                }
            } else if (child.type === 'method_declaration') {
                const receiver = receiverTypeName(child);
                const name = child.childForFieldName('name')?.text;
                if (receiver && name) {
                    let methods = this.methodsByType.get(receiver);
                    if (!methods) {
                        methods = new Map();
                        this.methodsByType.set(receiver, methods);
                    }
                    this.addCandidate(methods, name, child);
                }
            }
        }
    }

    private addCandidate(map: Map<string, Parser.SyntaxNode[]>, name: string, node: Parser.SyntaxNode): void {
        const existing = map.get(name);
        if (existing) {
            existing.push(node);
        } else {
            map.set(name, [node]);
        }
    }

    /** Resolves a bare type name to a package-level struct/interface type_spec declared in this file. */
    public resolveTopLevelType(name: string): Parser.SyntaxNode | null {
        return this.topLevelTypes.get(name) ?? null;
    }

    /** Resolves a bare call to a package-level function declared in this file (unambiguous only). */
    public resolveTopLevelFunction(name: string): Parser.SyntaxNode | null {
        const candidates = this.topLevelFunctions.get(name);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }

    /** Resolves `recv.Method()` to a method declared on `receiverType` in this file (unambiguous only). */
    public resolveMethodOnType(receiverType: string, methodName: string): Parser.SyntaxNode | null {
        const candidates = this.methodsByType.get(receiverType)?.get(methodName);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }
}
