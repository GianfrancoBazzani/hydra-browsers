/** STYLE.md section 5: the part of a TOTP period that is left. */
export interface CountdownRingProps {
  /** From 0 to 1. */
  fraction: number;
  label: string;
}

const RADIUS = 7;
const LENGTH = 2 * Math.PI * RADIUS;

export function CountdownRing({ fraction, label }: CountdownRingProps) {
  const left = Math.min(1, Math.max(0, fraction));
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-os-tone-strong"
      />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-os-accent"
        strokeDasharray={LENGTH}
        strokeDashoffset={LENGTH * (1 - left)}
      />
    </svg>
  );
}
