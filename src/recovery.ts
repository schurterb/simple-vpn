import type { ResourceType } from './journal-types.js';
import type { Journal } from './journal.js';

export interface ResourceChecker {
  exists(identity: string): boolean;
  matches(identity: string, attributes: Record<string, unknown>): boolean;
  remove(identity: string): void;
}

export type ResourceCheckerRegistry = Partial<Record<ResourceType, ResourceChecker>>;

export interface SweepResult {
  removed: string[];
  warnings: string[];
  skipped: string[];
}

export function runRecoverySweep(
  journal: Journal,
  checkers: ResourceCheckerRegistry,
): SweepResult {
  const result: SweepResult = { removed: [], warnings: [], skipped: [] };
  const activeEntries = journal.getActiveEntries();

  for (const entry of activeEntries) {
    const checker = checkers[entry.resourceType];

    if (!checker) {
      result.warnings.push(
        `No checker for resource type "${entry.resourceType}" (entry ${entry.id}, identity "${entry.identity}") — skipping`,
      );
      result.skipped.push(entry.id);
      continue;
    }

    const liveExists = checker.exists(entry.identity);

    if (!liveExists) {
      journal.updateState(entry.id, 'removed');
      journal.removeEntry(entry.id);
      result.skipped.push(entry.id);
      continue;
    }

    if (!checker.matches(entry.identity, entry.attributes)) {
      result.warnings.push(
        `Resource ${entry.resourceType} "${entry.identity}" (entry ${entry.id}) attributes mismatch — leaving untouched. Manual cleanup may be required.`,
      );
      result.skipped.push(entry.id);
      continue;
    }

    try {
      checker.remove(entry.identity);
      journal.updateState(entry.id, 'removed');
      journal.removeEntry(entry.id);
      result.removed.push(entry.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.warnings.push(
        `Failed to remove ${entry.resourceType} "${entry.identity}" (entry ${entry.id}): ${msg}. Manual cleanup may be required.`,
      );
      result.skipped.push(entry.id);
    }
  }

  return result;
}
