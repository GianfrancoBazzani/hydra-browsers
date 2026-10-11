import { Outlet } from 'react-router';
import { AppWindow } from '../../components/os';
import { UserEventsProvider } from '../../lib/events';
import { LiveTabProvider } from '../../lib/live-tab';
import { AppSidebar } from './AppSidebar';

/** The app window with the sidebar. The user SSE stream is open while it is shown. */
export function AppShell() {
  return (
    <UserEventsProvider>
      <LiveTabProvider>
        <AppWindow sidebar={<AppSidebar />}>
          <Outlet />
        </AppWindow>
      </LiveTabProvider>
    </UserEventsProvider>
  );
}
