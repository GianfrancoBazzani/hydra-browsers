import { useId, type ReactNode } from 'react';

/** The centered 360px panel of Login and Change password (STYLE.md section 4). */
export function AuthPanel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex h-full items-center justify-center p-(--os-window-inset)">
      <section
        aria-labelledby={id}
        className="flex w-90 flex-col gap-4 rounded-xl bg-os-surface/70 p-6 shadow-os-window backdrop-blur-2xl"
      >
        <h1 id={id} className="text-os-xl font-semibold text-os-foreground">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}
