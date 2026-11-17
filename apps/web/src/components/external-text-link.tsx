import type { ReactNode } from "react";

export const textLinkClass = "rounded-sm text-accent-strong underline-offset-4 hover:underline";

// A link inside a sentence that opens another site in a new tab.
export function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className={textLinkClass}>
      {children}
    </a>
  );
}
