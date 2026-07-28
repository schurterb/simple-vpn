import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { JournalEntry, ResourceType, LifecycleState } from './journal-types.js';

function isValidEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['resourceType'] === 'string' &&
    typeof o['identity'] === 'string' &&
    (o['action'] === 'create' || o['action'] === 'delete') &&
    typeof o['attributes'] === 'object' && o['attributes'] !== null &&
    typeof o['state'] === 'string' &&
    typeof o['createdAt'] === 'number' &&
    typeof o['updatedAt'] === 'number'
  );
}

export class Journal {
  private entries: Map<string, JournalEntry> = new Map();

  constructor(private readonly journalPath: string) {}

  load(): JournalEntry[] {
    this.entries.clear();

    if (!existsSync(this.journalPath)) {
      return [];
    }

    const raw = readFileSync(this.journalPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isValidEntry(parsed)) {
          const entry = parsed as JournalEntry;
          this.entries.set(entry.id, entry);
        }
      } catch {
        // skip corrupt lines
      }
    }

    return this.getAllEntries();
  }

  append(
    resourceType: ResourceType,
    identity: string,
    action: 'create' | 'delete',
    attributes: Record<string, unknown>,
  ): JournalEntry {
    const now = Math.floor(Date.now() / 1000);
    const entry: JournalEntry = {
      id: randomBytes(16).toString('hex'),
      resourceType,
      identity,
      action,
      attributes,
      state: 'intended',
      createdAt: now,
      updatedAt: now,
    };

    this.appendToDisk(entry);
    this.entries.set(entry.id, entry);
    return entry;
  }

  updateState(id: string, state: LifecycleState): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Journal entry ${id} not found`);
    }
    entry.state = state;
    entry.updatedAt = Math.floor(Date.now() / 1000);
    this.appendToDisk(entry);
  }

  removeEntry(id: string): void {
    this.entries.delete(id);
    this.rewriteDisk();
  }

  getActiveEntries(): JournalEntry[] {
    return this.getAllEntries().filter(
      (e) => e.state === 'intended' || e.state === 'created',
    );
  }

  getEntriesByType(resourceType: ResourceType): JournalEntry[] {
    return this.getAllEntries().filter((e) => e.resourceType === resourceType);
  }

  getAllEntries(): JournalEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  clear(): void {
    this.entries.clear();
    this.rewriteDisk();
  }

  private appendToDisk(entry: JournalEntry): void {
    const dir = dirname(this.journalPath);
    mkdirSync(dir, { recursive: true });
    appendFileSync(this.journalPath, JSON.stringify(entry) + '\n');
  }

  // VALIDATE[minor] F19 (PRD CF2/CF7): plain writeFileSync — crash mid-rewrite truncates the journal.
  // fix: atomic temp+rename (reuse atomic-io writeAtomically).
  private rewriteDisk(): void {
    const dir = dirname(this.journalPath);
    mkdirSync(dir, { recursive: true });
    const lines = this.getAllEntries().map((e) => JSON.stringify(e));
    writeFileSync(this.journalPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  }
}
