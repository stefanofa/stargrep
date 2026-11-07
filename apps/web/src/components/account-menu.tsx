import { Menu } from "@base-ui/react/menu";
import { Avatar, cn, popupSurface } from "@stargrep/ui";
import { signOut } from "../lib/auth-client.ts";

export function AccountMenu({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Account menu for ${login}`} className="rounded-full">
        <Avatar person={avatarUrl === null ? { login } : { login, avatarUrl }} index={1} className="size-11 border-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50 outline-none">
          <Menu.Popup className={cn(popupSurface, "flex min-w-48 flex-col")}>
            <span className="px-3 pt-1.5 pb-2 text-sm text-muted-foreground">@{login}</span>
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
