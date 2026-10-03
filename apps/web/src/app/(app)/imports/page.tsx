'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { ImportView, Page } from '@workeasy/shared';
import { Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, Table, Td, Th } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, IMPORT_STATUS, useWorkspaceApi } from '@/lib/audience';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';

/** Client-side size hint only; the API enforces the real limit while streaming. */
const MAX_HINT_BYTES = 20 * 1024 * 1024;

function ImportsInner() {
  const router = useRouter();
  const { workspaceId, path } = useWorkspaceApi();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imports = useInfiniteQuery({
    queryKey: audienceKeys.imports(workspaceId!),
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<Page<ImportView>>(path(`/imports?limit=25${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });

  async function upload(file: File) {
    setError(null);
    if (!/\.(csv|txt)$/i.test(file.name)) return setError('Choose a .csv file.');
    if (file.size > MAX_HINT_BYTES) return setError('That file is larger than 20 MB. Split it into smaller files.');
    setUploading(true);
    try {
      const created = await http.upload<ImportView>(path(`/imports?fileName=${encodeURIComponent(file.name)}`), file, 'text/csv');
      router.push(`/imports/${created.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setUploading(false);
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  const rows = imports.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader title="Imports" description="Add or update contacts from a CSV file. You will map columns and see exactly what will happen before anything changes." />
      <Card className="mb-6">
        <div
          className="flex flex-col items-center gap-3 rounded-control border-2 border-dashed border-line p-8 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
        >
          <Upload className="size-8 text-ink-faint" aria-hidden />
          <p className="text-sm text-ink-muted">Drop a CSV file here, or</p>
          <input ref={input} id="csv-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button loading={uploading} onClick={() => input.current?.click()}>
            Choose file
          </Button>
          <p className="text-xs text-ink-faint">UTF-8 CSV with a header row, up to 20 MB and 100,000 rows.</p>
        </div>
        {error && (
          <div className="mt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </Card>
      {imports.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No imports yet">Your import history will appear here.</EmptyState>
      ) : (
        <Table label="Imports">
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Status</Th>
              <Th className="text-right">Rows</Th>
              <Th>Result</Th>
              <Th>Uploaded</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <Td>
                  <Link href={`/imports/${i.id}`} className="break-all font-medium hover:text-accent">
                    {i.fileName}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={IMPORT_STATUS[i.status].tone}>{IMPORT_STATUS[i.status].label}</Badge>
                </Td>
                <Td className="text-right tabular-nums">{i.totalRows?.toLocaleString() ?? '—'}</Td>
                <Td className="text-xs text-ink-muted">
                  {i.status === 'completed' || i.status === 'processing' || i.processedRows > 0
                    ? `${i.counts.created} created · ${i.counts.updated} updated · ${i.counts.skipped} skipped · ${i.counts.errors} errors`
                    : '—'}
                </Td>
                <Td>{relativeTime(i.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {imports.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="secondary" onClick={() => void imports.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export default function ImportsPage() {
  return (
    <AudiencePage>
      <ImportsInner />
    </AudiencePage>
  );
}
