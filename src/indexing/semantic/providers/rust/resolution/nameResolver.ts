import Parser = require('node-tree-sitter');
import { implTraitName, implTypeName, isSelfMethod } from '../astHelpers';

/**
 * Scope-based name lookup replacing a real compiler -- confined to
 * same-file declarations only, matching every previous provider's tier.
 * Indexes module-level struct/enum/trait items by name (for INSTANTIATES/
 * IMPLEMENTS/EXTENDS-supertrait resolution) and functions/methods grouped
 * by their owning type or trait name (for CALLS resolution via both
 * `self.method()` and `Type::method()` associated-call forms). Rust
 * supports real overloading-shaped ambiguity via trait method name
 * collisions across multiple impl blocks for the same type, so candidates
 * are tracked as lists and only resolved when unambiguous, following the
 * exact pattern established after the Java overload-collision bug.
 */
export class RustNameResolver {
    private topLevelTypes = new Map<string, Parser.SyntaxNode>();
    private topLevelTraits = new Map<string, Parser.SyntaxNode>();
    private methodsByType = new Map<string, Map<string, Parser.SyntaxNode[]>>();

    constructor(root: Parser.SyntaxNode) {
        for (const child of root.namedChildren) {
            if (child.type === 'struct_item' || child.type === 'enum_item') {
                const name = child.childForFieldName('name')?.text;
                if (name) {
                    this.topLevelTypes.set(name, child);
                }
            } else if (child.type === 'trait_item') {
                const name = child.childForFieldName('name')?.text;
                if (name) {
                    this.topLevelTraits.set(name, child);
                }
            } else if (child.type === 'impl_item') {
                this.indexImplMethods(child);
            }
        }
    }

    private indexImplMethods(implNode: Parser.SyntaxNode): void {
        // A trait impl's methods are indexed under the *type* name (e.g.
        // `impl Speak for Animal`'s methods are called as `Animal::speak`
        // or `animal.speak()`, never `Speak::speak`) -- the trait name is
        // only relevant for IMPLEMENTS, not for call resolution.
        const typeName = implTypeName(implNode);
        if (!typeName) {
            return;
        }
        const body = implNode.childForFieldName('body');
        if (!body) {
            return;
        }
        let methods = this.methodsByType.get(typeName);
        if (!methods) {
            methods = new Map();
            this.methodsByType.set(typeName, methods);
        }
        for (const member of body.namedChildren) {
            if (member.type !== 'function_item') {
                continue;
            }
            const name = member.childForFieldName('name')?.text;
            if (!name) {
                continue;
            }
            this.addCandidate(methods, name, member);
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

    /** Resolves a bare type name to a module-level struct/enum item declared in this file. */
    public resolveTopLevelType(name: string): Parser.SyntaxNode | null {
        return this.topLevelTypes.get(name) ?? null;
    }

    /** Resolves a bare trait name to a module-level trait_item declared in this file. */
    public resolveTopLevelTrait(name: string): Parser.SyntaxNode | null {
        return this.topLevelTraits.get(name) ?? null;
    }

    /** Resolves `Type::method()`/`value.method()` to a function_item declared in one of `Type`'s impl blocks in this file (unambiguous only). */
    public resolveMethodOnType(typeName: string, methodName: string): Parser.SyntaxNode | null {
        const candidates = this.methodsByType.get(typeName)?.get(methodName);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }

    /** True if `funcNode` (an already-resolved method) takes self -- used by relationshipResolver to decide field_expression vs scoped_identifier call shape is consistent with the target. */
    public static isSelfMethod(funcNode: Parser.SyntaxNode): boolean {
        return isSelfMethod(funcNode);
    }
}
