import { Menu } from "@base-ui/react/menu";
import { Avatar, cn, popupSurface, SwitchMark } from "@stargrep/ui";
import { useId } from "react";
import { signOut } from "../lib/auth-client.ts";
import { type MonthlyPicks, useMonthlyPicks } from "../lib/monthly-picks.ts";

const explained = "a short email of repos you'd like, from your stars. no other email.";
const pickLines: Record<MonthlyPicks["kind"], string> = {
  unread: explained,
  reading: explained,
  shown: explained,
  saving: explained,
  unreadable: "couldn't load this. try again in a bit",
  "rolled-back": "couldn't save that. try again",
};

export function AccountMenu({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  const { picks, read, set } = useMonthlyPicks();
  const id = useId();
  const optedIn = "optedIn" in picks && picks.optedIn;
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) read();
      }}
    >
      <Menu.Trigger aria-label={`Account menu for ${login}`} className="rounded-full">
        <Avatar person={avatarUrl === null ? { login } : { login, avatarUrl }} index={1} className="size-11 border-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50 outline-none">
          <Menu.Popup className={cn(popupSurface, "flex w-72 flex-col")}>
            <span className="px-3 pt-1.5 pb-2 text-sm text-muted-foreground">@{login}</span>
            <Menu.CheckboxItem
              checked={optedIn}
              onCheckedChange={set}
              disabled={!("optedIn" in picks)}
              aria-labelledby={`${id}-label`}
              aria-describedby={`${id}-line`}
              className="flex items-center gap-3 rounded-item px-3 py-2 outline-none data-disabled:opacity-60 data-highlighted:bg-muted"
            >
              <span className="flex flex-1 flex-col gap-0.5">
                <span id={`${id}-label`}>monthly picks</span>
                <span id={`${id}-line`} className="text-sm font-normal text-muted-foreground">
                  {pickLines[picks.kind]}
                </span>
              </span>
              <SwitchMark checked={optedIn} />
            </Menu.CheckboxItem>
            <Menu.Item
              onClick={() => {
                signOut().catch(() => {});
              }}
              className="flex h-9 items-center rounded-item px-3 outline-none data-highlighted:bg-muted"
            >
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
