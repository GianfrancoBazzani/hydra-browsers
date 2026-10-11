import { Link } from 'react-router';
import { ContentPane, Toolbar } from '../../components/os';

export function NotFoundPage() {
  return (
    <>
      <Toolbar title="Not found" />
      <ContentPane className="items-center justify-center gap-2 p-6 text-center">
        <p className="text-os-base text-os-foreground">
          This page does not exist, or you have no access to it.
        </p>
        <Link to="/" className="text-os-base text-os-blue-accessible underline">
          Go to the start page
        </Link>
      </ContentPane>
    </>
  );
}
