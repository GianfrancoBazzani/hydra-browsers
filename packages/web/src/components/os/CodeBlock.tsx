import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { IconButton } from './Button';
import { OsIcon } from './icon';

export interface CodeBlockProps {
  code: string;
  /** Accessible name of the block, for example "Claude Code command". */
  label: string;
}

export function CodeBlock({ code, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <figure aria-label={label} className="relative rounded-os-control bg-os-gray-6">
      <pre className="overflow-x-auto py-2 pr-10 pl-3 font-mono text-os-sm break-all whitespace-pre-wrap text-os-foreground">
        <code>{code}</code>
      </pre>
      <IconButton aria-label="Copy" onClick={copy} className="absolute top-1 right-1">
        <OsIcon icon={copied ? IconCheck : IconCopy} />
      </IconButton>
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </figure>
  );
}
