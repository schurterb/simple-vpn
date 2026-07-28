import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function writeAtomically(filePath: string, data: string | Buffer): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmpPath, data);

  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function readJsonFile<T>(filePath: string): T {
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

export function writeJsonAtomically<T>(filePath: string, data: T): void {
  const json = JSON.stringify(data, null, 2);
  writeAtomically(filePath, json);
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
