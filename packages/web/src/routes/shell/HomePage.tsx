import { ContentPane, Toolbar } from '../../components/os';

export function HomePage() {
  return (
    <>
      <Toolbar title="Hydra Browsers" />
      <ContentPane className="items-center justify-center p-6">
        <p className="max-w-90 text-center text-os-base text-os-gray-accessible">
          Select a session in the sidebar, or create one with the New session button next to “My
          sessions”.
        </p>
      </ContentPane>
    </>
  );
}
