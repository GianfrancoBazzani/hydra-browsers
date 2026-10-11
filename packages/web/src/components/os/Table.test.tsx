import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Table, type Column } from './Table';

interface Row {
  id: string;
  name: string;
  calls: number;
}

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (row) => row.name },
  { key: 'calls', header: 'Calls', cell: (row) => row.calls, align: 'right' },
];

describe('Table', () => {
  it('renders a labelled table with column headers and rows', () => {
    render(
      <Table
        label="Tokens"
        columns={COLUMNS}
        rows={[
          { id: 'a', name: 'ci', calls: 12 },
          { id: 'b', name: 'laptop', calls: 3 },
        ]}
        rowKey={(row) => row.id}
      />,
    );
    const table = screen.getByRole('table', { name: 'Tokens' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Calls']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: '12' })).toHaveClass('text-right');
  });

  it('shows the empty text', () => {
    render(
      <Table
        label="Tokens"
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        empty="No tokens"
      />,
    );
    expect(screen.getByRole('cell', { name: 'No tokens' })).toBeInTheDocument();
  });

  it('reports row clicks', async () => {
    const onRowClick = vi.fn();
    render(
      <Table
        label="Events"
        columns={COLUMNS}
        rows={[{ id: 'a', name: 'ci', calls: 1 }]}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    await userEvent.click(screen.getByRole('cell', { name: 'ci' }));
    expect(onRowClick).toHaveBeenCalledWith({ id: 'a', name: 'ci', calls: 1 });
  });
});
