import * as ToggleGroup from '@radix-ui/react-toggle-group';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group, for example "Views". */
  label: string;
  value: T;
  segments: readonly Segment<T>[];
  onValueChange: (value: T) => void;
}

/** Radix ToggleGroup (single). Arrow keys move the focus, Enter or Space selects. */
export function SegmentedControl<T extends string>({
  label,
  value,
  segments,
  onValueChange,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const segment = segments.find((s) => s.value === next);
        if (segment) onValueChange(segment.value);
      }}
      className="inline-flex h-(--os-control-height) items-center gap-0.5 rounded-os-control bg-os-tone p-0.5"
    >
      {segments.map((segment) => (
        <ToggleGroup.Item
          key={segment.value}
          value={segment.value}
          className="h-full rounded-os-control px-3 text-os-base font-medium text-os-foreground transition-colors duration-(--os-duration-fast) ease-os-out data-[state=on]:bg-os-segment-selected data-[state=on]:shadow-os-control"
        >
          {segment.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
