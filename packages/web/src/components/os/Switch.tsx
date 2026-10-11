import * as SwitchPrimitive from '@radix-ui/react-switch';
import { useId } from 'react';

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, checked, onCheckedChange, disabled = false }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="group relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-os-gray-4 transition-colors duration-(--os-duration-fast) ease-os-out disabled:opacity-40 data-[state=checked]:bg-os-accent dark:bg-os-gray-3"
      >
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-os-on-fill shadow-os-control transition-[translate] duration-(--os-duration-fast) ease-os-out data-[state=checked]:translate-x-4.5 motion-reduce:transition-none" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className="text-os-base text-os-foreground">
        {label}
      </label>
    </div>
  );
}
