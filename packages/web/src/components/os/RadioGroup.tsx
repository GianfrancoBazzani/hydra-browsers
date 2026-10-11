import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { useId } from 'react';
import { cx } from './cx';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

export interface RadioGroupProps<T extends string> {
  label: string;
  value: T;
  options: readonly RadioOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
}

export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  orientation = 'horizontal',
}: RadioGroupProps<T>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={`${id}-label`} className="text-os-base text-os-foreground">
        {label}
      </span>
      <RadioGroupPrimitive.Root
        aria-labelledby={`${id}-label`}
        value={value}
        onValueChange={(next) => {
          const option = options.find((o) => o.value === next);
          if (option) onValueChange(option.value);
        }}
        disabled={disabled}
        orientation={orientation}
        className={cx(
          'flex gap-x-4 gap-y-2',
          orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap',
        )}
      >
        {options.map((option) => (
          <div key={option.value} className="flex items-center gap-2">
            <RadioGroupPrimitive.Item
              id={`${id}-${option.value}`}
              value={option.value}
              className="flex size-4 shrink-0 items-center justify-center rounded-full border border-os-gray-2 bg-os-surface disabled:opacity-40 data-[state=checked]:border-os-accent-fill data-[state=checked]:bg-os-accent-fill"
            >
              <RadioGroupPrimitive.Indicator className="block size-1.5 rounded-full bg-os-on-fill" />
            </RadioGroupPrimitive.Item>
            <label htmlFor={`${id}-${option.value}`} className="text-os-base text-os-foreground">
              {option.label}
            </label>
          </div>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}
