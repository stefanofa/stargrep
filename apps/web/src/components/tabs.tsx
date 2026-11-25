import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface Tab {
  readonly name: string;
  readonly link: LinkProps;
  // A number beside the name, such as how many stars.
  readonly count?: ReactNode;
}

// A row of tabs, each a plain link to its own address, so every tab paints from the server and opens in a new tab. The
// current one is the page you are on. The row's top edge is a 1.5px rule, and the current tab sits on a 3px underline.
export function Tabs({ label, tabs, current }: { label: string; tabs: ReadonlyArray<Tab>; current: string }) {
  return (
    <nav aria-label={label} className="border-t-[1.5px] border-muted">
      <ul className="flex items-end gap-[26px] sm:gap-9">
        {tabs.map((tab) => (
          <li key={tab.name}>
            <Link
              {...tab.link}
              aria-current={tab.name === current ? "page" : undefined}
              className="flex items-baseline gap-[5px] border-b-[3px] border-transparent pt-3 pb-2.5 font-display font-semibold text-muted-foreground transition-colors duration-120 hover:text-foreground focus-visible:-outline-offset-2 aria-[current=page]:border-foreground aria-[current=page]:text-foreground sm:gap-[7px] sm:pt-4 sm:pb-3.5"
            >
              <span className="text-[20px] leading-6 sm:text-xl sm:leading-7">{tab.name}</span>
              {tab.count !== undefined && (
                <span className="text-meta tabular-nums sm:text-[16px] sm:leading-5">{tab.count}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
