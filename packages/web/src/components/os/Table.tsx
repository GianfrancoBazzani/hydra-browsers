import type { ReactNode } from 'react';
import { cx } from './cx';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Numbers align right (STYLE.md section 5). */
  align?: 'left' | 'right';
  className?: string;
}

export interface TableProps<T> {
  /** Accessible name of the table. */
  label: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Shown in one row when `rows` is empty. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}

export function Table<T>({ label, columns, rows, rowKey, empty, onRowClick }: TableProps<T>) {
  return (
    <table aria-label={label} className="w-full border-collapse text-os-base text-os-foreground">
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cx(
                'h-(--os-table-row-height) bg-os-gray-6 px-3 text-os-xs font-semibold whitespace-nowrap text-os-gray-accessible dark:bg-os-gray-5',
                column.align === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr className="border-t border-os-separator">
            <td colSpan={columns.length} className="px-3 py-6 text-center text-os-gray-accessible">
              {empty ?? 'Nothing here yet.'}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={
                onRowClick
                  ? () => {
                      onRowClick(row);
                    }
                  : undefined
              }
              className={cx(
                'h-(--os-table-row-height) border-t border-os-separator hover:bg-os-tone',
                onRowClick && 'cursor-default',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    'px-3 py-1',
                    column.align === 'right' && 'text-right tabular-nums',
                    column.className,
                  )}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
