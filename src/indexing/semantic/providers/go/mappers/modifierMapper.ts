/**
 * Go has no visibility keywords or attribute/annotation syntax at all --
 * visibility is purely a capitalization convention (exported vs.
 * unexported), and there's nothing analogous to `modifiers`. This is
 * actually simpler and more deterministic than Java's/C#'s keyword-based
 * visibility: no default-guessing needed, a single character check
 * decides it, and unexported identifiers are just as real a structural
 * part of a package as exported ones -- capitalization is a visibility
 * concern only, not a DECLARES/identity inclusion filter.
 */
export class ModifierMapper {
    public map(name: string): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const firstChar = name.charAt(0);
        const isExported = firstChar.length > 0 && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
        return { modifiers: [], visibility: isExported ? 'public' : 'internal' };
    }
}
