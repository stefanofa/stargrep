import { Menu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { CheckIcon } from "./icons.tsx";
import { popupSurface } from "./popup.ts";

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
}

// A menu that picks one of its choices, with a check on the current one. The trigger is any element, such as a chip,
// and the menu scrolls when its choices outgrow the screen.
export function RadioMenu<T extends string>({
  trigger,
  label,
  choices,
  value,
  onValueChange,
  children,
}: {
  trigger: ReactElement;
  label: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} render={trigger}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" collisionPadding={16} className="z-50 outline-none">
          <Menu.Popup className={cn(popupSurface, "max-h-(--available-height) min-w-52 overflow-y-auto")}>
            <Menu.RadioGroup
              value={value}
              onValueChange={(next) => {
                const choice = choices.find((option) => option.value === next);
                if (choice !== undefined) onValueChange(choice.value);
              }}
            >
              {choices.map((choice) => (
                <Menu.RadioItem
                  key={choice.value}
                  value={choice.value}
                  closeOnClick
                  className="flex h-9 cursor-default items-center justify-between gap-3 rounded-item px-3 select-none data-highlighted:bg-accent-soft"
                >
                  {choice.label}
                  <Menu.RadioItemIndicator>
                    <CheckIcon className="size-3.5 text-accent-strong" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
