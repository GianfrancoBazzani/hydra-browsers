import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { IconCheck } from '@tabler/icons-react';
import { useId } from 'react';
import { OsIcon } from './icon';

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onCheckedChange, disabled = false }: CheckboxProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(value) => {
          onCheckedChange(value === true);
        }}
        disabled={disabled}
        className="flex size-4 shrink-0 items-center justify-center rounded-os-checkbox border border-os-gray-2 bg-os-surface disabled:opacity-40 data-[state=checked]:border-os-accent-fill data-[state=checked]:bg-os-accent-fill"
      >
        <CheckboxPrimitive.Indicator className="text-os-on-fill">
          <OsIcon icon={IconCheck} size={12} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="text-os-base text-os-foreground">
        {label}
      </label>
    </div>
  );
}
