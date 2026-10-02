'use client';

import { useQuery } from '@tanstack/react-query';
import type { OrganizationView } from '@workeasy/shared';
import { Building2, Check, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { errorMessage } from '@/lib/forms';
import { keys, useOptionalAppContext, useResetCache } from '@/lib/session';

export default function OrganizationsPage() {
  const ctx = useOptionalAppContext();
  const router = useRouter();
  const reset = useResetCache();
  const toast = useToast();
  const orgs = useQuery({ queryKey: keys.organizations, queryFn: () => http.get<{ data: OrganizationView[] }>('/v1/organizations') });

  async function open(id: string) {
    try {
      await http.put('/v1/me/context', { organizationId: id, workspaceId: null });
      await reset();
      router.push('/dashboard');
    } catch (err) {
      toast('danger', errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Organizations you belong to. Each one has its own members, roles and workspaces."
        actions={
          <Link href="/onboarding">
            <Button icon={<Plus className="size-4" />}>New organization</Button>
          </Link>
        }
      />
      {orgs.isLoading && <Spinner />}
      {orgs.isError && <Alert tone="danger">{errorMessage(orgs.error)}</Alert>}
      {orgs.data?.data.length === 0 && (
        <EmptyState icon={<Building2 className="size-8" />} title="You are not in any organization yet" action={<Link href="/onboarding"><Button>Create an organization</Button></Link>}>
          Create one, or ask a colleague to invite you to theirs.
        </EmptyState>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {orgs.data?.data.map((o) => (
          <Card key={o.id}>
            <div className="flex items-center gap-3">
              <Building2 className="size-8 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{o.name}</p>
                <p className="text-sm text-ink-muted">
                  Your role: <Badge>{o.role.name}</Badge>
                </p>
              </div>
              {ctx?.organization?.id === o.id ? (
                <Badge tone="accent">
                  <Check className="mr-1 size-3" aria-hidden /> Current
                </Badge>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => open(o.id)}>
                  Open
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
