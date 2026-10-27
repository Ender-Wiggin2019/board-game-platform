/** A single value accepted by the shared list filter wire format. */
export type TListFilterValue = string | string[];

/** JSON-serializable filters carried by list endpoints. */
export type TListFilters = Record<string, TListFilterValue>;

export interface IListQuery<TFilters extends object = TListFilters> {
  pageSize?: number;
  pageNum?: number;
  sort?: string;
  filters?: TFilters;
}

export interface IListResponse<T> {
  list: T[];
  total: number;
  pageSize: number;
  pageNum: number;
  sort?: string;
}
