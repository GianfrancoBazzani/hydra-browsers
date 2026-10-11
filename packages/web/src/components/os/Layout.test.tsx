import { render, screen, within } from '@testing-library/react';
import { IconUsers } from '@tabler/icons-react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppWindow, ContentPane } from './AppWindow';
import { Sidebar, SidebarItem, SidebarSection } from './Sidebar';
import { Toolbar } from './Toolbar';

function renderLayout(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppWindow
        sidebar={
          <Sidebar footer={<span>Ana</span>}>
            <SidebarSection title="My sessions">
              <SidebarItem
                to="/sessions/q2w3e4r5t6y7"
                label="Banking"
                state="running"
                agentConnected
              />
              <SidebarItem to="/sessions/z7x6c5v4b3n2" label="Shop" state="stopped" />
            </SidebarSection>
            <SidebarSection title="Admin">
              <SidebarItem to="/admin/users" label="Users" icon={IconUsers} />
            </SidebarSection>
          </Sidebar>
        }
      >
        <Toolbar title="Banking" subtitle="Running" actions={<button type="button">Stop</button>} />
        <ContentPane>content</ContentPane>
      </AppWindow>
    </MemoryRouter>,
  );
}

describe('AppWindow, Sidebar, and Toolbar', () => {
  it('has decorative traffic lights', () => {
    renderLayout('/');
    expect(screen.getByTestId('traffic-lights')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the sidebar sections as labelled regions', () => {
    renderLayout('/');
    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    const mine = within(nav).getByRole('region', { name: 'My sessions' });
    expect(
      within(mine)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['RunningBankingAgent connected', 'StoppedShop']);
    expect(within(nav).getByRole('region', { name: 'Admin' })).toBeInTheDocument();
  });

  it('marks the item of the current page', () => {
    renderLayout('/sessions/q2w3e4r5t6y7/live');
    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('Banking');
    expect(current).toHaveClass('bg-os-accent-fill', 'text-os-on-fill');
  });

  it('shows the toolbar title as the page heading and the content as main', () => {
    renderLayout('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Banking' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('content');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});
