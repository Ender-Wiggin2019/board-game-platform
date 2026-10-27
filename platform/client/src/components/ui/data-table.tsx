import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/cn';

export type TDataTableFilterValue = string | string[];

export interface TDataTableState {
  pageNum: number;
  pageSize: number;
  sort?: string;
  filters: Record<string, TDataTableFilterValue>;
}

export interface IDataTableCapabilities {
  filters?: 'visible' | 'hidden';
  pageSize?: 'selectable' | 'fixed-hidden';
  pagination?: 'visible' | 'hidden';
}

interface IDataTableContextValue {
  state: TDataTableState;
  updateState: (patch: Partial<TDataTableState>) => void;
}

const DataTableContext = React.createContext<IDataTableContextValue | null>(
  null,
);

export type TDataTableFilter =
  | {
      id: string;
      label: string;
      type: 'text';
      placeholder?: string;
    }
  | {
      id: string;
      label: string;
      type: 'select';
      options: Array<{ label: string; value: string }>;
    }
  | {
      id: string;
      label: string;
      type: 'multi-select';
      options: Array<{ label: string; value: string }>;
    };

interface IDataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  total: number;
  state: TDataTableState;
  onStateChange: (state: TDataTableState) => void;
  filters?: TDataTableFilter[];
  capabilities?: IDataTableCapabilities;
  pageSizeOptions?: readonly number[];
  loading?: boolean;
  emptyText?: string;
  errorText?: string;
  tableLabel?: string;
  className?: string;
  minWidthClassName?: string;
  onRowActivate?: (row: TData) => void;
  isRowActivatable?: (row: TData) => boolean;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  total,
  state,
  onStateChange,
  filters = [],
  capabilities,
  pageSizeOptions = [10, 25, 50, 100],
  loading = false,
  emptyText,
  errorText,
  tableLabel,
  className,
  minWidthClassName,
  onRowActivate,
  isRowActivatable,
}: IDataTableProps<TData, TValue>): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
  });
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const showFilters = capabilities?.filters !== 'hidden';
  const showPageSize =
    capabilities?.pageSize !== 'fixed-hidden' && pageSizeOptions.length > 1;
  const showPagination = capabilities?.pagination !== 'hidden';

  const updateState = React.useCallback(
    (patch: Partial<TDataTableState>) => {
      onStateChange({ ...state, ...patch });
    },
    [onStateChange, state],
  );

  return (
    <DataTableContext.Provider value={{ state, updateState }}>
      <div className={cn('space-y-3', className)}>
        {showFilters && filters.length > 0 ? (
          <div className='flex flex-wrap items-end gap-3'>
            {filters.map((filter) => (
              <DataTableFilterControl
                key={filter.id}
                filter={filter}
                state={state}
                updateState={updateState}
              />
            ))}
          </div>
        ) : null}

        <Table aria-label={tableLabel} className={cn(minWidthClassName)}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className='hover:bg-transparent'>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {errorText ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center text-[var(--signal-red)]'
                  role='alert'
                >
                  {errorText || t('client.data_table.error')}
                </TableCell>
              </TableRow>
            ) : loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center text-text-400'
                >
                  <span role='status'>{t('client.data_table.loading')}</span>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => {
                const activatable =
                  onRowActivate !== undefined &&
                  (isRowActivatable?.(row.original) ?? true);
                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      activatable && 'cursor-pointer active:bg-surface-800/80',
                    )}
                    onClick={
                      activatable
                        ? (event) => {
                            if (
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey ||
                              hasNestedInteractiveTarget(event)
                            ) {
                              return;
                            }
                            onRowActivate(row.original);
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center text-text-400'
                >
                  {emptyText ?? t('client.data_table.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {showPagination ? (
          <div className='flex flex-wrap items-center justify-between gap-3 text-sm text-text-400'>
            <div className='font-mono tabular-nums'>
              {t('client.data_table.page', {
                page: state.pageNum,
                pageCount,
              })}
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              {showPageSize ? (
                <label className='flex items-center gap-2'>
                  <span className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
                    {t('client.data_table.rows_per_page')}
                  </span>
                  <select
                    aria-label={t('client.data_table.rows_per_page')}
                    value={state.pageSize}
                    onChange={(event) =>
                      updateState({
                        pageNum: 1,
                        pageSize: Number(event.currentTarget.value),
                      })
                    }
                    className='h-8 rounded-[5px] bg-[oklch(0.12_0.02_260)] px-2 font-mono text-sm text-text-100'
                  >
                    {pageSizeOptions.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button
                variant='ghost'
                size='sm'
                onClick={() => updateState({ pageNum: state.pageNum - 1 })}
                disabled={state.pageNum <= 1}
                aria-label={t('client.data_table.previous_page')}
              >
                <ChevronLeft aria-hidden size={14} />
                {t('client.data_table.previous')}
              </Button>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => updateState({ pageNum: state.pageNum + 1 })}
                disabled={state.pageNum >= pageCount}
                aria-label={t('client.data_table.next_page')}
              >
                {t('client.data_table.next')}
                <ChevronRight aria-hidden size={14} />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </DataTableContext.Provider>
  );
}

function hasNestedInteractiveTarget(
  event: React.SyntheticEvent<HTMLTableRowElement>,
): boolean {
  if (!(event.target instanceof Element)) return false;
  const interactive = event.target.closest(ROW_ACTIVATION_IGNORE_SELECTOR);
  return interactive !== null && interactive !== event.currentTarget;
}

const ROW_ACTIVATION_IGNORE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'label',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
].join(',');

export function DataTableColumnHeader({
  field,
  title,
  className,
}: {
  field: string;
  title: string;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const context = React.useContext(DataTableContext);
  const direction = getSortDirection(context?.state.sort, field);
  const nextSort = direction === 'asc' ? `${field}:desc` : `${field}:asc`;

  return (
    <button
      type='button'
      className={cn(
        'inline-flex items-center gap-1 text-left font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500 transition-colors hover:text-text-100',
        className,
      )}
      onClick={() => context?.updateState({ pageNum: 1, sort: nextSort })}
      aria-label={t('client.data_table.sort', { column: title })}
      data-testid={`data-table-sort-${field}`}
    >
      <span>{title}</span>
      <span aria-hidden className='text-text-700'>
        <SortIcon direction={direction} />
      </span>
    </button>
  );
}

function SortIcon({
  direction,
}: {
  direction: 'asc' | 'desc' | null;
}): React.JSX.Element {
  if (direction === 'asc') {
    return <ArrowUp size={14} />;
  }
  if (direction === 'desc') {
    return <ArrowDown size={14} />;
  }
  return <ArrowUpDown size={14} />;
}

function DataTableFilterControl({
  filter,
  state,
  updateState,
}: {
  filter: TDataTableFilter;
  state: TDataTableState;
  updateState: (patch: Partial<TDataTableState>) => void;
}): React.JSX.Element {
  const value = state.filters[filter.id];
  const updateFilter = (nextValue: TDataTableFilterValue | undefined): void => {
    const nextFilters = { ...state.filters };
    if (
      nextValue === undefined ||
      nextValue === '' ||
      (Array.isArray(nextValue) && nextValue.length === 0)
    ) {
      delete nextFilters[filter.id];
    } else {
      nextFilters[filter.id] = nextValue;
    }
    updateState({ pageNum: 1, filters: nextFilters });
  };

  if (filter.type === 'text') {
    return (
      <label className='min-w-[220px] flex-1 space-y-1.5'>
        <span className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
          {filter.label}
        </span>
        <Input
          aria-label={filter.label}
          value={typeof value === 'string' ? value : ''}
          placeholder={filter.placeholder}
          onChange={(event) => updateFilter(event.currentTarget.value)}
        />
      </label>
    );
  }

  if (filter.type === 'multi-select') {
    return (
      <label className='space-y-1.5'>
        <span className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
          {filter.label}
        </span>
        <select
          aria-label={filter.label}
          multiple
          value={Array.isArray(value) ? value : []}
          onChange={(event) =>
            updateFilter(
              Array.from(event.currentTarget.selectedOptions).map(
                (option) => option.value,
              ),
            )
          }
          className='min-h-32 rounded-[5px] bg-[oklch(0.12_0.02_260)] px-3 py-2 text-sm text-text-100'
        >
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className='min-w-[180px] space-y-1.5'>
      <span className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
        {filter.label}
      </span>
      <select
        aria-label={filter.label}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => updateFilter(event.currentTarget.value)}
        className='h-10 w-full rounded-[5px] bg-[oklch(0.12_0.02_260)] px-3 text-sm text-text-100'
      >
        {filter.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function getSortDirection(
  sort: string | undefined,
  field: string,
): 'asc' | 'desc' | null {
  const [sortField, direction] = sort?.split(':') ?? [];
  if (sortField !== field) {
    return null;
  }
  return direction === 'asc' || direction === 'desc' ? direction : null;
}
