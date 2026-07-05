import Parser = require('node-tree-sitter');
import { effectiveParent } from '../astHelpers';

/**
 * Scope-based name lookup replacing typeChecker.getSymbolAtLocation -- Python
 * has no embeddable equivalent, so resolution here is confined to same-file
 * declarations only (module-level functions/classes, and methods within the
 * same class), matching how TS's own single-file ProgramHandle already
 * confines its own resolution to one file (see programProvider.ts). No
 * subclass/MRO-aware dispatch, no cross-module resolution -- an unresolved
 * lookup returns null, which callers turn into a KnownUnknown, not a guess.
 */
export class PythonNameResolver {
    private moduleLevel = new Map<string, Parser.SyntaxNode>();
    private methodsByClass = new Map<string, Map<string, Parser.SyntaxNode>>();

    constructor(root: Parser.SyntaxNode) {
        this.index(root, null);
    }

    private index(node: Parser.SyntaxNode, enclosingClassName: string | null): void {
        for (const child of node.namedChildren) {
            if (child.type === 'decorated_definition') {
                const inner = child.namedChildren.find(c => c.type === 'class_definition' || c.type === 'function_definition');
                if (inner) {
                    this.indexDefinition(inner, enclosingClassName);
                }
                continue;
            }
            if (child.type === 'class_definition' || child.type === 'function_definition') {
                this.indexDefinition(child, enclosingClassName);
            }
        }
    }

    private indexDefinition(node: Parser.SyntaxNode, enclosingClassName: string | null): void {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        if (node.type === 'class_definition') {
            if (enclosingClassName === null) {
                this.moduleLevel.set(name, node);
            }
            const body = node.childForFieldName('body');
            if (body) {
                this.index(body, name);
            }
        } else {
            if (enclosingClassName === null) {
                this.moduleLevel.set(name, node);
            } else {
                let classMethods = this.methodsByClass.get(enclosingClassName);
                if (!classMethods) {
                    classMethods = new Map();
                    this.methodsByClass.set(enclosingClassName, classMethods);
                }
                classMethods.set(name, node);
            }
        }
    }

    /** Resolves a bare (unqualified) name to a module-level function/class declaration in this file. */
    public resolveModuleLevel(name: string): Parser.SyntaxNode | null {
        return this.moduleLevel.get(name) ?? null;
    }

    /**
     * Resolves `self.method_name(...)` / `cls.method_name(...)` to a method
     * declared directly in the enclosing class -- not inherited methods, since
     * that would require real MRO knowledge this resolver doesn't have.
     */
    public resolveMethodOnEnclosingClass(callSiteNode: Parser.SyntaxNode, methodName: string): Parser.SyntaxNode | null {
        const enclosingClass = this.findEnclosingClass(callSiteNode);
        if (!enclosingClass) {
            return null;
        }
        const className = enclosingClass.childForFieldName('name')?.text;
        if (!className) {
            return null;
        }
        return this.methodsByClass.get(className)?.get(methodName) ?? null;
    }

    private findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
        let current = effectiveParent(node);
        while (current) {
            if (current.type === 'class_definition') {
                return current;
            }
            current = effectiveParent(current);
        }
        return null;
    }
}
