import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx } from './cx';

/** Reads `--os-duration-out` (STYLE.md section 2.7). 0 when the token is not loaded (tests). */
function exitDurationMs(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--os-duration-out')
    .trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

/** Keeps the sheet mounted while its exit transition runs. */
function useExitPresence(open: boolean): boolean {
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open);
  }
  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => {
      setClosing(false);
    }, exitDurationMs());
    return () => {
      window.clearTimeout(timer);
    };
  }, [closing]);
  return open || closing;
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** 560px instead of 480px (the token sheet). */
  wide?: boolean;
  /**
   * The control that gets the focus after the sheet closes. Use it when the opener is a menu
   * item. Without it, the focus goes back to the element that had the focus when the sheet
   * opened (Radix Dialog alone returns it only to a Dialog.Trigger).
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/** Radix Dialog that moves down from the bottom of the toolbar (STYLE.md section 5). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  wide = false,
  returnFocusRef,
  children,
}: SheetProps) {
  const present = useExitPresence(open);
  const opener = useRef<HTMLElement | null>(null);
  const phase = open ? 'open' : 'closing';
  return (
    <Dialog.Root
      open={present}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          data-phase={phase}
          className="fixed inset-0 z-(--os-z-overlay) bg-os-overlay opacity-100 transition-opacity duration-(--os-duration-base) ease-os-out starting:opacity-0 data-[phase=closing]:opacity-0 data-[phase=closing]:duration-(--os-duration-out) data-[phase=closing]:ease-os-in"
        />
        <Dialog.Content
          data-phase={phase}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            opener.current = active instanceof HTMLElement ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocusRef?.current ?? opener.current)?.focus();
          }}
          className={cx(
            'fixed inset-x-0 top-[calc(var(--os-window-inset)+var(--os-toolbar-height))] z-(--os-z-sheet) mx-auto flex max-h-[calc(100vh-2*var(--os-window-inset)-var(--os-toolbar-height))] flex-col rounded-b-xl bg-os-surface text-os-foreground shadow-os-menu',
            'translate-y-0 opacity-100 transition-[translate,opacity] duration-(--os-duration-base) ease-os-out starting:-translate-y-2 starting:opacity-0',
            'data-[phase=closing]:-translate-y-2 data-[phase=closing]:opacity-0 data-[phase=closing]:duration-(--os-duration-out) data-[phase=closing]:ease-os-in',
            'motion-reduce:translate-y-0 motion-reduce:starting:translate-y-0 motion-reduce:data-[phase=closing]:translate-y-0',
            wide ? 'w-140' : 'w-120',
          )}
        >
          <div className="flex flex-col gap-1 px-5 pt-4">
            <Dialog.Title className="text-os-base font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="text-os-base text-os-gray-accessible">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The scrolling middle part of a sheet. */
export function SheetBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>;
}

/** Buttons on the right: Cancel first, then the action (STYLE.md section 5). */
export function SheetFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 px-5 pb-4">{children}</div>;
}
