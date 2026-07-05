import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves Rust's crate/module-path-based identity and `use` targets.
 * Genuinely more intricate than Go's or Java's resolver: Rust `use` paths
 * can be crate-relative (`crate::`), current-module-relative (`self::`),
 * parent-module-relative (`super::`), the crate's own name (equivalent to
 * `crate::`, read from Cargo.toml's `[package].name`), or a bare external
 * crate name (out of scope, same tier as stdlib in the other providers).
 * Confirmed against a real Cargo.toml and a real `self::`-relative
 * re-export in reqwest's lib.rs, not assumed to transfer from Go's design.
 */
export class RustCrateResolver {
    /** Walks up from `filePath` looking for the nearest Cargo.toml, returning the crate root directory and its declared package name. */
    public static findCrate(filePath: string): { crateRoot: string; crateName: string } {
        let dir = path.dirname(filePath);
        for (;;) {
            const cargoTomlPath = path.join(dir, 'Cargo.toml');
            if (fs.existsSync(cargoTomlPath)) {
                const crateName = this.parseCrateName(fs.readFileSync(cargoTomlPath, 'utf8'));
                return { crateRoot: dir, crateName: crateName ?? '' };
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break; // reached filesystem root
            }
            dir = parent;
        }
        return { crateRoot: path.dirname(filePath), crateName: '' };
    }

    private static parseCrateName(cargoTomlContent: string): string | null {
        const packageSectionMatch = cargoTomlContent.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
        const section = packageSectionMatch ? packageSectionMatch[1] : cargoTomlContent;
        const match = section.match(/^name\s*=\s*"([^"]+)"/m);
        return match ? match[1] : null;
    }

    /** Computes this file's own resolvable module path (e.g. "reqwest::async_impl::body"), from its position relative to `<crateRoot>/src/`. */
    public static computeModulePath(filePath: string, crateRoot: string, crateName: string): string {
        const srcDir = path.join(crateRoot, 'src');
        let rel = path.relative(srcDir, filePath).split(path.sep).join('/');
        if (rel.endsWith('.rs')) {
            rel = rel.slice(0, -3);
        }
        const segments = rel.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        if (last === 'mod' || last === 'lib' || last === 'main') {
            segments.pop();
        }
        return crateName ? [crateName, ...segments].join('::') : segments.join('::');
    }

    /**
     * Resolves a `use` path's target to a real file under this crate, only
     * for `crate::`/`self::`/`super::`/own-crate-name-prefixed paths.
     * Everything else (an external crate, or `std`/`core`/`alloc`) is out
     * of scope and correctly unresolved.
     */
    public static resolveUse(useText: string, filePath: string, crateRoot: string, crateName: string): string | null {
        const segments = useText.split('::');
        const first = segments[0];

        let baseDir: string;
        let remainder: string[];
        if (first === 'crate' || (crateName && first === crateName)) {
            baseDir = path.join(crateRoot, 'src');
            remainder = segments.slice(1);
        } else if (first === 'self') {
            baseDir = this.selfModuleDir(filePath);
            remainder = segments.slice(1);
        } else if (first === 'super') {
            baseDir = this.parentModuleDir(filePath);
            remainder = segments.slice(1);
        } else {
            return null; // external crate (or std/core/alloc) -- out of scope, not attempted
        }

        return this.resolveUnderDir(baseDir, remainder);
    }

    /** The directory that holds this file's own submodules -- `foo/mod.rs`'s and `lib.rs`'s own directory, or a leaf `foo.rs`'s sibling `foo/` directory (2018+ edition convention). */
    private static selfModuleDir(filePath: string): string {
        const base = path.basename(filePath, '.rs');
        const dir = path.dirname(filePath);
        if (base === 'mod' || base === 'lib' || base === 'main') {
            return dir;
        }
        return path.join(dir, base);
    }

    /** The directory that holds the *parent* module's own submodules -- one level up from a `mod.rs`'s own directory, or a leaf file's containing directory (which already IS its parent module's submodule directory). */
    private static parentModuleDir(filePath: string): string {
        const base = path.basename(filePath, '.rs');
        const dir = path.dirname(filePath);
        if (base === 'mod') {
            return path.dirname(dir);
        }
        return dir; // leaf file or lib.rs/main.rs (no real parent -- best-effort fallback)
    }

    /**
     * Tries the full remainder as a module path first (e.g. `use
     * crate::config;` imports the module itself). If that fails, retries
     * with the last segment dropped, treating it as an imported item name
     * rather than a module segment. Confirmed necessary via direct AST/FS
     * testing against reqwest: `use crate::error::Error;`'s remainder is
     * ["error", "Error"], but only "error" is a real file/directory
     * segment -- "Error" is the struct imported from within it, not
     * itself a path component. Without this fallback the common
     * `use path::to::module::Item;` shape would never resolve.
     */
    private static resolveUnderDir(baseDir: string, remainder: string[]): string | null {
        const full = this.tryResolvePath(baseDir, remainder);
        if (full) {
            return full;
        }
        if (remainder.length > 0) {
            return this.tryResolvePath(baseDir, remainder.slice(0, -1));
        }
        return null;
    }

    private static tryResolvePath(baseDir: string, segments: string[]): string | null {
        if (segments.length === 0) {
            return fs.existsSync(baseDir) ? baseDir : null;
        }
        const joined = path.join(baseDir, ...segments);
        const asFile = joined + '.rs';
        const asModDir = path.join(joined, 'mod.rs');
        if (fs.existsSync(asFile)) return asFile;
        if (fs.existsSync(asModDir)) return asModDir;
        return null;
    }
}
