import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { OsIcon } from './icon';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

const ITEM =
  'flex h-(--os-control-height-sm) cursor-default items-center gap-2 rounded-os-checkbox px-2 select-none data-disabled:opacity-40';

export interface MenuContentProps {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export function MenuContent({ children, align = 'end', side = 'bottom' }: MenuContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={4}
        collisionPadding={8}
        className="z-(--os-z-menu) max-h-(--radix-dropdown-menu-content-available-height) min-w-40 overflow-y-auto rounded-os-menu bg-os-surface p-1 text-os-sm text-os-foreground shadow-os-menu"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export function MenuItem({
  children,
  onSelect,
  destructive = false,
  disabled = false,
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cx(
        ITEM,
        destructive
          ? 'text-os-red-accessible data-highlighted:bg-os-danger-fill data-highlighted:text-os-on-fill'
          : 'data-highlighted:bg-os-accent-fill data-highlighted:text-os-on-fill',
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

/** Text in a menu that is not an item, for example the email of the user. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 py-1 text-os-xs text-os-gray-accessible">
      {children}
    </DropdownMenu.Label>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-os-separator" />;
}

export interface MenuRadioGroupProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onValueChange: (value: T) => void;
}

export function MenuRadioGroup<T extends string>({
  label,
  value,
  options,
  onValueChange,
}: MenuRadioGroupProps<T>) {
  return (
    <DropdownMenu.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      {options.map((option) => (
        <DropdownMenu.RadioItem
          key={option.value}
          value={option.value}
          className={cx(
            ITEM,
            'relative pl-6 data-highlighted:bg-os-accent-fill data-highlighted:text-os-on-fill',
          )}
        >
          <DropdownMenu.ItemIndicator className="absolute left-1.5">
            <OsIcon icon={IconCheck} size={12} />
          </DropdownMenu.ItemIndicator>
          {option.label}
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}
