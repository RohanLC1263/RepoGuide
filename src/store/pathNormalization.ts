/**
 * Case+slash-folded form of a file path, for use ONLY as a lookup/matching key
 * (SQL `lower(filePath) = ?` comparisons, dedup sets like `touchedFiles`) --
 * never as a persisted value.
 *
 * Folding case for the persisted value was a real, confirmed bug (see
 * docs/engineering-log/HALLUCINATION_INVESTIGATION_REPORT.md): LogicalUnitStore/FactStore each had
 * their own copy of this function and applied it to the stored `filePath`
 * column, silently diverging it from `id` (built earlier from the real,
 * un-folded path) for any file whose real path contains uppercase letters --
 * corrupting citations on case-sensitive filesystems. Both stores now import
 * this one shared helper for matching only, so the same drift can't recur
 * under a third writer.
 */
export function normalizeFilePathForLookup(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}
