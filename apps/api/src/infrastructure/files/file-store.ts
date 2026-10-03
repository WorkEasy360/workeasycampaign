import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { AppError } from '../../common/errors.js';

/**
 * Storage for uploaded files. Keys are built by the server from ids only (never from client file names), and are
 * re-validated here so a bad key can never escape the storage root (path traversal). Local disk today; an
 * S3-compatible store implements the same interface (Phase 8, assets).
 */
export interface FileStore {
  save(key: string, source: Readable, opts: { maxBytes: number; validateUtf8?: boolean }): Promise<{ size: number; sha256: string }>;
  open(key: string): Readable;
  remove(key: string): Promise<void>;
}

export const FILE_STORE = Symbol('FILE_STORE');
const KEY_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.[a-z0-9]{1,8}$/;

export class LocalFileStore implements FileStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Invalid storage key: ${key}`);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Storage key escapes the storage root');
    return p;
  }

  /**
   * Streams `source` to disk while enforcing the size limit and (optionally) UTF-8 validity. On a violation it stops
   * writing but keeps reading and discarding the rest of `source`: destroying an HTTP request body mid-upload would
   * reset the connection and the client would never see the error response.
   */
  async save(key: string, source: Readable, opts: { maxBytes: number; validateUtf8?: boolean }) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash('sha256');
    const decoder = opts.validateUtf8 ? new TextDecoder('utf-8', { fatal: true }) : null;
    const out = createWriteStream(path, { flags: 'wx' });
    let size = 0;
    try {
      await new Promise<void>((resolveSave, rejectSave) => {
        let failed = false;
        const fail = (err: unknown) => {
          if (failed) return;
          failed = true;
          out.destroy();
          source.resume(); // drain and discard the remainder
          rejectSave(err);
        };
        source.on('data', (chunk: Buffer) => {
          if (failed) return;
          size += chunk.length;
          if (size > opts.maxBytes) {
            fail(new AppError('validation_failed', 413, `The file is larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`, { file: ['FILE_TOO_LARGE'] }));
            return;
          }
          try {
            decoder?.decode(chunk, { stream: true });
          } catch {
            fail(new AppError('validation_failed', 400, 'The file is not valid UTF-8 text. Save it as "CSV UTF-8" and try again.', { file: ['ENCODING_INVALID'] }));
            return;
          }
          hash.update(chunk);
          if (!out.write(chunk)) {
            source.pause();
            out.once('drain', () => source.resume());
          }
        });
        source.on('error', fail);
        out.on('error', fail);
        source.on('end', () => {
          if (failed) return;
          try {
            decoder?.decode();
          } catch {
            fail(new AppError('validation_failed', 400, 'The file ends with an incomplete UTF-8 character', { file: ['ENCODING_INVALID'] }));
            return;
          }
          out.end(() => resolveSave());
        });
      });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { size, sha256: hash.digest('hex') };
  }

  open(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
