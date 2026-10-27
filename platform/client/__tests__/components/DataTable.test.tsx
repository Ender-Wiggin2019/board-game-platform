import type { ColumnDef } from '@tanstack/react-table';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  DataTableColumnHeader,
  type TDataTableState,
} from '@/components/ui/data-table';
import i18n from '@/i18n';

interface ITestRow {
  id: string;
  email: string;
  role: string;
}

const columns: ColumnDef<ITestRow>[] = [
  {
    accessorKey: 'email',
    header: () => <DataTableColumnHeader field='email' title='Email' />,
    cell: ({ row }) => row.original.email,
  },
  {
    accessorKey: 'role',
    header: 'Role',
    cell: ({ row }) => row.original.role,
  },
];

const initialState: TDataTableState = {
  pageNum: 1,
  pageSize: 10,
  filters: {},
};

describe('DataTable', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('emits backend table state for sort, filters, page size, and pagination', async () => {
    const emittedStates: TDataTableState[] = [];

    function Harness(): React.JSX.Element {
      const [state, setState] = useState(initialState);
      return (
        <DataTable
          columns={columns}
          data={[{ id: 'u1', email: 'ada@test.com', role: 'admin' }]}
          total={25}
          state={state}
          onStateChange={(nextState) => {
            emittedStates.push(nextState);
            setState(nextState);
          }}
          filters={[
            {
              id: 'search',
              label: 'Search',
              type: 'text',
              placeholder: 'Search users',
            },
            {
              id: 'role',
              label: 'Role',
              type: 'select',
              options: [
                { label: 'All roles', value: '' },
                { label: 'Admin', value: 'admin' },
              ],
            },
          ]}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText('ada@test.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sort Email' }));
    expect(emittedStates.at(-1)).toEqual({
      pageNum: 1,
      pageSize: 10,
      filters: {},
      sort: 'email:asc',
    });

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'ada' },
    });
    expect(emittedStates.at(-1)).toEqual({
      pageNum: 1,
      pageSize: 10,
      sort: 'email:asc',
      filters: { search: 'ada' },
    });

    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'admin' },
    });
    expect(emittedStates.at(-1)).toEqual({
      pageNum: 1,
      pageSize: 10,
      sort: 'email:asc',
      filters: { search: 'ada', role: 'admin' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(emittedStates.at(-1)).toEqual({
      pageNum: 2,
      pageSize: 10,
      sort: 'email:asc',
      filters: { search: 'ada', role: 'admin' },
    });

    fireEvent.change(screen.getByLabelText('Rows per page'), {
      target: { value: '25' },
    });
    expect(emittedStates.at(-1)).toEqual({
      pageNum: 1,
      pageSize: 25,
      sort: 'email:asc',
      filters: { search: 'ada', role: 'admin' },
    });

    await waitFor(() =>
      expect(screen.getByText('Page 1 of 1')).toBeInTheDocument(),
    );
  });

  it('uses lucide icons for sort and pagination controls', () => {
    render(
      <DataTable
        columns={columns}
        data={[{ id: 'u1', email: 'ada@test.com', role: 'admin' }]}
        total={25}
        state={initialState}
        onStateChange={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'Sort Email' })
        .querySelector('.lucide-arrow-up-down'),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole('button', { name: 'Previous page' })
        .querySelector('.lucide-chevron-left'),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole('button', { name: 'Next page' })
        .querySelector('.lucide-chevron-right'),
    ).toBeInTheDocument();
  });

  it('enhances activatable row clicks without hijacking nested controls or ordinary rows', () => {
    const onRowActivate = vi.fn();
    const row = { id: 'u1', email: 'ada@test.com', role: 'admin' };
    const columnsWithAction: ColumnDef<ITestRow>[] = [
      ...columns,
      {
        id: 'action',
        cell: () => <button type='button'>Row action</button>,
      },
    ];
    const { rerender } = render(
      <DataTable
        columns={columnsWithAction}
        data={[row]}
        total={1}
        state={initialState}
        onStateChange={vi.fn()}
        onRowActivate={onRowActivate}
      />,
    );

    const interactiveRow = screen.getByText('ada@test.com').closest('tr');
    if (!interactiveRow) throw new Error('Expected an interactive data row');
    expect(interactiveRow).toHaveClass(
      'cursor-pointer',
      'hover:bg-surface-800/50',
      'active:bg-surface-800/80',
    );
    expect(interactiveRow).not.toHaveAttribute('role');

    fireEvent.click(screen.getByRole('button', { name: 'Row action' }));
    expect(onRowActivate).not.toHaveBeenCalled();
    fireEvent.click(interactiveRow, { ctrlKey: true });
    expect(onRowActivate).not.toHaveBeenCalled();
    fireEvent.click(interactiveRow);

    expect(onRowActivate).toHaveBeenCalledOnce();
    expect(onRowActivate).toHaveBeenCalledWith(row);

    rerender(
      <DataTable
        columns={columns}
        data={[row]}
        total={1}
        state={initialState}
        onStateChange={vi.fn()}
      />,
    );

    const ordinaryRow = screen.getByText('ada@test.com').closest('tr');
    expect(ordinaryRow).not.toHaveClass('cursor-pointer');
  });

  it('renders loading and empty states', () => {
    const onStateChange = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={columns}
        data={[]}
        total={0}
        state={initialState}
        onStateChange={onStateChange}
        loading
      />,
    );

    expect(screen.getByText('Loading rows...')).toBeInTheDocument();

    rerender(
      <DataTable
        columns={columns}
        data={[]}
        total={0}
        state={initialState}
        onStateChange={onStateChange}
      />,
    );

    expect(screen.getByText('No results.')).toBeInTheDocument();
  });

  it.each([
    {
      language: 'zh-CN',
      loading: '正在加载数据...',
      page: '第 1 / 3 页',
      previous: '转到上一页',
      next: '转到下一页',
      rows: '每页行数',
      sort: '按Email排序',
    },
  ])(
    'localizes visible and accessible controls in $language',
    async ({ language, loading, page, previous, next, rows, sort }) => {
      await i18n.changeLanguage(language);

      render(
        <DataTable
          columns={columns}
          data={[]}
          total={25}
          state={initialState}
          onStateChange={vi.fn()}
          loading
        />,
      );

      expect(screen.getByText(loading)).toBeInTheDocument();
      expect(screen.getByText(page)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: previous }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: next })).toBeInTheDocument();
      expect(screen.getByLabelText(rows)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: sort })).toBeInTheDocument();
      expect(screen.queryByText('Loading rows...')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Next page' }),
      ).not.toBeInTheDocument();
    },
  );

  it('keeps pagination while hiding fixed page-size and filters', () => {
    render(
      <DataTable
        columns={columns}
        data={[{ id: 'u1', email: 'ada@test.com', role: 'admin' }]}
        total={25}
        state={initialState}
        onStateChange={vi.fn()}
        filters={[{ id: 'search', label: 'Search', type: 'text' }]}
        capabilities={{ filters: 'hidden', pageSize: 'fixed-hidden' }}
        pageSizeOptions={[10]}
      />,
    );

    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Rows per page')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Next page' }),
    ).toBeInTheDocument();
  });
});
