import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { useSession } from '../../api/sessions';
import { Banner, ContentPane, Toolbar } from '../../components/os';
import { NotFoundPage } from '../shell/NotFoundPage';
import { useSessionResource } from './outlet';
import { SessionToolbar } from './SessionToolbar';
import { allowedViews, viewFromPath } from './views';

/** /sessions/:sid: the toolbar and the selected view. A view without the right redirects. */
export function SessionLayout() {
  const { sid = '' } = useParams();
  const session = useSession(sid);
  const location = useLocation();

  // 404: no such session, or no access any more (rights change, spec 6.5). TanStack Query keeps
  // the old data after a failed refetch, so check the error before the data.
  if (session.isError && isApiError(session.error, 'not_found')) return <NotFoundPage />;

  if (session.data === undefined) {
    if (session.isError) {
      return (
        <>
          <Toolbar title="Session" />
          <ContentPane className="p-6">
            <Banner variant="warning" role="alert">
              {errorMessage(session.error)}
            </Banner>
          </ContentPane>
        </>
      );
    }
    return (
      <>
        <Toolbar title="Loading…" />
        <ContentPane />
      </>
    );
  }

  // A deleted session (SSE event `deleted`, see removeSession) has no page any more.
  if (session.data.state === 'deleted') return <NotFoundPage />;

  const views = allowedViews(session.data.rights);
  const view = viewFromPath(location.pathname);
  if (view !== null && !views.some((v) => v.value === view)) {
    const first = views[0];
    return <Navigate to={first ? `/sessions/${sid}/${first.value}` : '/'} replace />;
  }

  return (
    <>
      <SessionToolbar key={session.data.id} session={session.data} view={view} views={views} />
      <ContentPane>
        <Outlet context={session.data} />
      </ContentPane>
    </>
  );
}

/** /sessions/:sid opens the first view that the user has rights for. */
export function SessionIndex() {
  const session = useSessionResource();
  const first = allowedViews(session.rights)[0];
  return <Navigate to={first ? first.value : '/'} replace />;
}
