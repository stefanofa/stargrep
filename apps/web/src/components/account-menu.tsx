import { Menu } from "@base-ui/react/menu";
import { Avatar } from "@stargrep/ui";
import { signOut } from "../lib/auth-client.ts";

export function AccountMenu({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Account menu for ${login}`} className="rounded-full">
        <Avatar person={avatarUrl === null ? { login } : { login, avatarUrl }} index={1} className="size-11 border-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50 outline-none">
          <Menu.Popup className="flex min-w-48 flex-col rounded-md border-[1.5px] border-border bg-card p-1.5 font-sans text-meta font-medium text-foreground outline-none transition-opacity duration-120 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <span className="px-3 pt-1.5 pb-2 text-sm text-muted-foreground">@{login}</span>
            <Menu.Item
              onClick={() => {
                signOut().catch(() => {});
              }}
              // 14px keeps the item concentric with the popup, rounded-md (20px) minus p-1.5 (6px).
              className="flex h-9 items-center rounded-[14px] px-3 outline-none data-highlighted:bg-muted"
            >
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
