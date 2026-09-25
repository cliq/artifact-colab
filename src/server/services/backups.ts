/**
 * Instance backups: a downloadable package of all current data.
 *
 * Everything the app stores lives in the SQLite database (assets are BLOBs),
 * so a package is a consistent snapshot of that file plus a manifest, as a
 * gzipped tarball:
 *
 *   artifact-colab-backup-<timestamp>.tar.gz
 *     ├── manifest.json   what this is and when it was taken
 *     └── app.db          the database, restorable by dropping it in as DATABASE_PATH
 *
 * Packing runs in two phases — SQLite's online-backup API (safe while the app
 * keeps serving and writing) into a temp file, then streaming that file
 * through tar + gzip — and reports progress for both so the admin page can
 * show a bar. One backup runs at a time. In-flight files carry a `.partial`
 * suffix and are only renamed to their final name when complete, so the
 * listing never shows a half-written package; leftovers from a crash are
 * swept when the manager starts.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import type Database from 'better-sqlite3';

/** Final package names. Anything else in the directory is ignored (and never served or deleted). */
const PACKAGE_RE = /^artifact-colab-backup-\d{8}T\d{6}Z-[0-9a-f]{6}\.tar\.gz$/;
const PARTIAL_SUFFIX = '.partial';

/** Share of the bar given to the snapshot phase; compression is the slower part. */
const SNAPSHOT_WEIGHT = 0.3;
/** Pages copied per online-backup step (4 KB pages → ~4 MB between yields). */
const PAGES_PER_STEP = 1000;

export interface BackupPackage {
  name: string;
  sizeBytes: number;
  createdAt: Date;
}

export type BackupPhase = 'snapshot' | 'compress';

export interface BackupJob {
  id: string;
  name: string;
  phase: BackupPhase;
  /** 0–100 across both phases. */
  percent: number;
  startedAt: Date;
}

export interface BackupFailure {
  message: string;
  at: Date;
}

/** A job as the admin page's poller sees it. */
export function backupJobView(job: BackupJob) {
  return { name: job.name, phase: job.phase, percent: job.percent, startedAt: job.startedAt.toISOString() };
}

export function isPackageName(name: string): boolean {
  return PACKAGE_RE.test(name);
}

/** e.g. 20260925T143000Z — sortable, and safe in file names on every OS. */
function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** One 512-byte ustar header for a regular file. */
function tarHeader(name: string, size: number, mtime: Date): Buffer {
  const header = Buffer.alloc(512);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 'ascii');
  header.write('        ', 148, 'ascii'); // checksum placeholder: spaces while summing
  header.write('0', 156, 'ascii'); // regular file
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

/** Zero bytes that round an entry up to the next 512-byte block. */
function tarPadding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

export class BackupManager {
  private job: BackupJob | null = null;
  private failure: BackupFailure | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly sqlite: Database.Database,
  ) {}

  /** Remove temp files a crashed or restarted process left behind. Call once at startup. */
  async sweepLeftovers(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const entry of await readdir(this.dir)) {
      if (entry.endsWith(PARTIAL_SUFFIX)) await rm(join(this.dir, entry), { force: true });
    }
  }

  current(): BackupJob | null {
    return this.job ? { ...this.job } : null;
  }

  lastFailure(): BackupFailure | null {
    return this.failure;
  }

  /** Completed packages, newest first. */
  async list(): Promise<BackupPackage[]> {
    if (!existsSync(this.dir)) return [];
    const rows: BackupPackage[] = [];
    for (const name of await readdir(this.dir)) {
      if (!isPackageName(name)) continue;
      const info = await stat(join(this.dir, name)).catch(() => null);
      if (info?.isFile()) rows.push({ name, sizeBytes: info.size, createdAt: info.mtime });
    }
    return rows.sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Absolute path of a completed package, or null for anything that isn't one (including traversal attempts). */
  pathFor(name: string): string | null {
    return isPackageName(name) ? join(this.dir, name) : null;
  }

  async delete(name: string): Promise<boolean> {
    const path = this.pathFor(name);
    if (!path || !existsSync(path)) return false;
    await rm(path, { force: true });
    return true;
  }

  /** Start packing in the background. Returns null when a backup is already running. */
  start(now: Date = new Date()): BackupJob | null {
    if (this.job) return null;
    const id = randomBytes(3).toString('hex');
    this.job = { id, name: `artifact-colab-backup-${compactTimestamp(now)}-${id}.tar.gz`, phase: 'snapshot', percent: 0, startedAt: now };
    this.failure = null;
    this.running = this.run(this.job)
      .catch((err: unknown) => {
        this.failure = { message: err instanceof Error ? err.message : String(err), at: new Date() };
        console.error('Backup failed:', err);
      })
      .finally(() => {
        this.job = null;
        this.running = null;
      });
    return this.current();
  }

  /** Resolves once the running backup (if any) settles. For tests and graceful shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async run(job: BackupJob): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const snapshotPath = join(this.dir, `${job.id}.db${PARTIAL_SUFFIX}`);
    const packagePath = join(this.dir, job.name + PARTIAL_SUFFIX);
    try {
      await this.sqlite.backup(snapshotPath, {
        progress: ({ totalPages, remainingPages }) => {
          if (totalPages > 0) job.percent = Math.round(((totalPages - remainingPages) / totalPages) * SNAPSHOT_WEIGHT * 100);
          return PAGES_PER_STEP;
        },
      });

      job.phase = 'compress';
      job.percent = Math.round(SNAPSHOT_WEIGHT * 100);
      const dbSize = (await stat(snapshotPath)).size;
      const manifest = Buffer.from(
        JSON.stringify({ format: 'artifact-colab-backup', version: 1, createdAt: job.startedAt.toISOString(), files: { 'app.db': dbSize } }, null, 2) + '\n',
      );

      let copied = 0;
      const countProgress = new Transform({
        transform(chunk: Buffer, _enc, done) {
          copied += chunk.length;
          job.percent = Math.round((SNAPSHOT_WEIGHT + (dbSize > 0 ? copied / dbSize : 1) * (1 - SNAPSHOT_WEIGHT)) * 100);
          done(null, chunk);
        },
      });

      async function* tarStream() {
        yield tarHeader('manifest.json', manifest.length, job.startedAt);
        yield manifest;
        yield tarPadding(manifest.length);
        yield tarHeader('app.db', dbSize, job.startedAt);
        for await (const chunk of createReadStream(snapshotPath).pipe(countProgress)) yield chunk as Buffer;
        yield tarPadding(dbSize);
        yield Buffer.alloc(1024); // end-of-archive: two empty blocks
      }

      await pipeline(Readable.from(tarStream()), createGzip(), createWriteStream(packagePath));
      await rename(packagePath, join(this.dir, job.name));
      job.percent = 100;
    } finally {
      await rm(snapshotPath, { force: true });
      await rm(packagePath, { force: true });
    }
  }
}
