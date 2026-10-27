import { ERole } from '@board-platform/contracts/auth/roles';
import type { IPlatformAdminUserSummary } from '@board-platform/contracts/types/protocol/administration';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platformAdministrationApi } from '@/api/platformAdministrationApi.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  DataTable,
  DataTableColumnHeader,
  type TDataTableState,
} from '@/components/ui/data-table.js';
import { toast } from '@/components/ui/toast.js';
import { usePermissions } from '@/hooks/usePermissions.js';

const EDITABLE_ROLES = [
  ERole.GUEST,
  ERole.PLAYER,
  ERole.TESTER,
  ERole.ADMIN,
  ERole.SUPERADMIN,
] as const;

function roleLabel(role: ERole): string {
  return role;
}

/** Generic platform account and role administration. */
export function UserManagementPanel(): React.JSX.Element {
  const { t } = useTranslation('platform-admin');
  const { role: actorRole } = usePermissions();
  const queryClient = useQueryClient();
  const [tableState, setTableState] = useState<TDataTableState>({
    pageNum: 1,
    pageSize: 25,
    sort: 'createdAt:desc',
    filters: {},
  });
  const [draftRoles, setDraftRoles] = useState<Record<string, ERole>>({});
  const users = useQuery({
    queryKey: ['platform-admin', 'users', tableState],
    queryFn: () => platformAdministrationApi.listUsers(tableState),
  });
  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: ERole }) =>
      platformAdministrationApi.setUserRole(input.userId, input.role),
    onSuccess: async (_user, input) => {
      setDraftRoles((current) => {
        const next = { ...current };
        delete next[input.userId];
        return next;
      });
      await queryClient.invalidateQueries({
        queryKey: ['platform-admin', 'users'],
      });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast({
        title: t('users.toast_role_updated'),
        variant: 'success',
      });
    },
    onError: (error) =>
      toast({
        title: t('users.toast_role_failed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      }),
  });
  const resetMutation = useMutation({
    mutationFn: (userId: string) =>
      platformAdministrationApi.resetUserPassword(userId),
    onSuccess: () =>
      toast({
        title: t('users.toast_password_reset'),
        variant: 'success',
      }),
    onError: (error) =>
      toast({
        title: t('users.toast_password_failed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      }),
  });
  const canEdit = (user: IPlatformAdminUserSummary): boolean =>
    actorRole === ERole.SUPERADMIN ||
    ![ERole.TESTER, ERole.ADMIN, ERole.SUPERADMIN].includes(user.baseRole);
  const columns = useMemo<ColumnDef<IPlatformAdminUserSummary>[]>(
    () => [
      {
        accessorKey: 'email',
        header: () => (
          <DataTableColumnHeader field='email' title={t('users.email')} />
        ),
        cell: ({ row }) => (
          <div className='space-y-1'>
            <span className='text-text-100'>{row.original.email}</span>
            <span className='block text-xs text-text-500'>
              {row.original.name}
            </span>
          </div>
        ),
      },
      {
        accessorKey: 'role',
        header: () => (
          <DataTableColumnHeader field='role' title={t('users.role')} />
        ),
        cell: ({ row }) => {
          const user = row.original;
          const selected = draftRoles[user.id] ?? user.baseRole;
          const editable = canEdit(user);
          return (
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant={user.role === ERole.ADMIN ? 'accent' : 'data'}>
                {roleLabel(user.role)}
              </Badge>
              <select
                aria-label={t('users.role_for', { email: user.email })}
                className='h-8 rounded border border-white/15 bg-[var(--surface-instrument)] px-2 text-xs text-text-100'
                value={selected === ERole.NAVIGATOR ? ERole.PLAYER : selected}
                disabled={!editable || roleMutation.isPending}
                onChange={(event) =>
                  setDraftRoles((current) => ({
                    ...current,
                    [user.id]: event.target.value as ERole,
                  }))
                }
              >
                {EDITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
              {draftRoles[user.id] && draftRoles[user.id] !== user.baseRole ? (
                <Button
                  size='sm'
                  loading={roleMutation.isPending}
                  onClick={() => {
                    const nextRole = draftRoles[user.id];
                    if (!nextRole) return;
                    roleMutation.mutate({ userId: user.id, role: nextRole });
                  }}
                >
                  {t('users.save_role')}
                </Button>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: t('users.actions'),
        cell: ({ row }) => (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            disabled={!canEdit(row.original) || resetMutation.isPending}
            onClick={() => resetMutation.mutate(row.original.id)}
          >
            {t('users.reset_password')}
          </Button>
        ),
      },
    ],
    [actorRole, draftRoles, resetMutation.isPending, roleMutation.isPending, t],
  );

  return (
    <section className='mission-panel px-5 py-5' aria-busy={users.isFetching}>
      <div className='relative z-10 space-y-4'>
        <div className='section-head'>
          <span aria-hidden className='section-head__tick' />
          <div>
            <p className='micro-label'>{t('users.heading')}</p>
            <p className='mt-1 text-sm text-text-400'>
              {t('users.description')}
            </p>
          </div>
          <div aria-hidden className='section-head__rule' />
        </div>
        <DataTable
          columns={columns}
          data={users.data?.list ?? []}
          total={users.data?.total ?? 0}
          state={tableState}
          onStateChange={setTableState}
          loading={users.isPending}
          errorText={users.isError ? t('users.load_failed') : undefined}
          emptyText={t('users.empty')}
          minWidthClassName='min-w-[900px]'
          filters={[
            {
              id: 'search',
              label: t('users.search'),
              type: 'text',
              placeholder: t('users.search_placeholder'),
            },
          ]}
        />
      </div>
    </section>
  );
}
