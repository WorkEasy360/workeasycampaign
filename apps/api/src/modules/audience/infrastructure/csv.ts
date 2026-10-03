import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { AppError } from '../../../common/errors.js';

export const CSV_LIMITS = { maxColumns: 100, maxCellChars: 2000, maxRecordBytes: 1024 * 1024 } as const;

/** Picks the delimiter that splits the header line into the most columns (outside quotes). */
export function detectDelimiter(firstLine: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]! += 1;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ',';
}

/** Reads the start of a stream (for delimiter detection) without consuming more than needed. */
export async function readHead(stream: Readable, bytes = 64 * 1024): Promise<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += (chunk as Buffer).toString('utf8');
    if (buf.length >= bytes) break;
  }
  stream.destroy();
  return buf.replace(/^﻿/, '');
}

function parser(delimiter: string) {
  return parse({
    delimiter,
    bom: true,
    relax_column_count: true,
    // Spreadsheet exports contain stray quotes inside unquoted cells (e.g. =HYPERLINK("…")); accept them as text.
    relax_quotes: true,
    skip_empty_lines: true,
    max_record_size: CSV_LIMITS.maxRecordBytes,
  });
}

function csvError(err: unknown): AppError {
  const e = err as { code?: string; message?: string; lines?: number };
  return new AppError('validation_failed', 400, `The file is not valid CSV${e.lines ? ` (near line ${e.lines})` : ''}: ${e.message ?? 'parse error'}`, {
    file: ['CSV_INVALID'],
  });
}

/** Streams data rows (header excluded) with 1-based row numbers. Never holds the whole file in memory. */
export async function* readRows(stream: Readable, delimiter: string): AsyncGenerator<{ rowNumber: number; cells: string[] }> {
  const p = stream.pipe(parser(delimiter));
  let rowNumber = 0;
  let header = true;
  try {
    for await (const record of p as AsyncIterable<string[]>) {
      if (header) {
        header = false;
        continue;
      }
      rowNumber += 1;
      yield { rowNumber, cells: record };
    }
  } catch (err) {
    throw csvError(err);
  } finally {
    stream.destroy();
  }
}

/** One full pass at upload: validates syntax and limits, returns the header and the data row count. */
export async function inspectCsv(stream: Readable, delimiter: string, maxRows: number): Promise<{ headers: string[]; totalRows: number }> {
  const p = stream.pipe(parser(delimiter));
  let headers: string[] | null = null;
  let totalRows = 0;
  try {
    for await (const record of p as AsyncIterable<string[]>) {
      if (!headers) {
        if (record.length > CSV_LIMITS.maxColumns) {
          throw new AppError('validation_failed', 400, `The file has more than ${CSV_LIMITS.maxColumns} columns`, { file: ['TOO_MANY_COLUMNS'] });
        }
        headers = record.map((h, i) => h.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || `Column ${i + 1}`);
        continue;
      }
      totalRows += 1;
      if (totalRows > maxRows) {
        throw new AppError('validation_failed', 413, `The file has more than ${maxRows.toLocaleString('en')} rows. Split it into smaller files.`, { file: ['TOO_MANY_ROWS'] });
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw csvError(err);
  } finally {
    stream.destroy();
  }
  if (!headers) throw new AppError('validation_failed', 400, 'The file is empty', { file: ['EMPTY_FILE'] });
  if (totalRows === 0) throw new AppError('validation_failed', 400, 'The file has a header row but no contacts', { file: ['NO_ROWS'] });
  return { headers, totalRows };
}

/** Display-only file name: strips any path and unsafe characters. Never used for storage. */
export function sanitizeFileName(name: string | undefined): string {
  const base = (name ?? 'contacts.csv').split(/[\\/]/).pop() ?? 'contacts.csv';
  const clean = base.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || 'contacts.csv';
}
