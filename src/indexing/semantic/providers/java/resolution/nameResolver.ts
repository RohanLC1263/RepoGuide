import Parser = require('node-tree-sitter');
import { findEnclosingTypeDeclaration } from '../astHelpers';

/**
 * Scope-based name lookup replacing a real type checker -- Java has no
 * embeddable equivalent, so resolution here is confined to same-file
 * declarations only: top-level types (for `new Foo()` / `extends Foo`) and
 * methods declared directly in a given class (for bare/`this.`/`this(...)`
 * calls). No inherited-method resolution, no cross-file resolution, and no
 * overload/arity resolution -- method/constructor names are indexed as
 * lists, not single nodes, and a name with more than one declaration (a
 * genuinely common pattern -- overloaded methods, constructor delegation
 * via `this(...)`) resolves to null rather than guessing which overload was
 * meant. An unresolved lookup becomes a KnownUnknown at the call site, not
 * a guess.
 */
export class JavaNameResolver {
    private topLevelTypes = new Map<string, Parser.SyntaxNode>();
    private methodsByClass = new Map<string, Map<string, Parser.SyntaxNode[]>>();

    constructor(root: Parser.SyntaxNode) {
        for (const child of root.namedChildren) {
            if (child.type === 'class_declaration' || child.type === 'interface_declaration' || child.type === 'enum_declaration') {
                this.indexType(child);
            }
        }
    }

    private indexType(typeNode: Parser.SyntaxNode): void {
        const name = typeNode.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        this.topLevelTypes.set(name, typeNode);

        const body = typeNode.childForFieldName('body');
        if (!body) {
            return;
        }
        const methods = new Map<string, Parser.SyntaxNode[]>();
        for (const member of body.namedChildren) {
            if (member.type === 'method_declaration' || member.type === 'constructor_declaration') {
                const methodName = member.childForFieldName('name')?.text;
                if (methodName) {
                    const existing = methods.get(methodName);
                    if (existing) {
                        existing.push(member);
                    } else {
                        methods.set(methodName, [member]);
                    }
                }
            } else if (member.type === 'class_declaration' || member.type === 'interface_declaration' || member.type === 'enum_declaration') {
                // Nested types are indexed for their own members too, but not
                // registered under topLevelTypes -- resolving `new Inner()`
                // from outside its enclosing class is out of scope (same
                // same-file-only, no-nesting-aware-lookup tier as Python).
                this.indexType(member);
            }
        }
        this.methodsByClass.set(name, methods);
    }

    /** Resolves a bare type name to a top-level class/interface/enum declaration in this file. */
    public resolveTopLevelType(name: string): Parser.SyntaxNode | null {
        return this.topLevelTypes.get(name) ?? null;
    }

    /**
     * Resolves a bare/`this.`/`this(...)` call to the method/constructor
     * declared directly in the enclosing class -- only when `methodName` is
     * unambiguous (exactly one declaration with that name) in that class.
     * Overloaded names resolve to null rather than picking an arbitrary
     * candidate, since there's no argument-type resolution to disambiguate.
     */
    public resolveMethodOnEnclosingClass(callSiteNode: Parser.SyntaxNode, methodName: string): Parser.SyntaxNode | null {
        const enclosingClass = findEnclosingTypeDeclaration(callSiteNode);
        if (!enclosingClass) {
            return null;
        }
        const className = enclosingClass.childForFieldName('name')?.text;
        if (!className) {
            return null;
        }
        const candidates = this.methodsByClass.get(className)?.get(methodName);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }
}
