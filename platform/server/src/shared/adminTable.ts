import type {
  IAdminTableQuery,
  IAdminTableResponse,
} from '@board-platform/contracts/types/protocol/inviteCodes';

export function tableOffset(
  query: Pick<IAdminTableQuery, 'pageSize' | 'pageNum'>,
): number {
  return Math.max(0, (query.pageNum ?? 1) - 1) * (query.pageSize ?? 50);
}

export function toAdminTableResponse<T>(input: {
  list: T[];
  total: number;
  pageSize: number;
  pageNum: number;
  sort?: string;
}): IAdminTableResponse<T> {
  return input;
}
