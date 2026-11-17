// A switch's track and thumb. Each reads data-checked, which Base UI's Switch sets and SwitchMark sets from its prop.
export const switchTrack =
  "flex h-[26px] w-11 shrink-0 items-center rounded-full bg-border p-[3px] transition-[color,background-color] duration-120 data-checked:bg-accent";
export const switchThumb =
  "size-5 rounded-full bg-[light-dark(var(--color-card),var(--color-muted-foreground))] shadow-[0_1px_2px_#1e1b2e33] transition-transform duration-120 data-checked:translate-x-[18px] motion-reduce:transition-none";

// The switch drawn inside a control that owns the checked state and its role, such as a menu's checkbox item.
export function SwitchMark({ checked }: { checked: boolean }) {
  const state = checked ? "" : undefined;
  return (
    <span aria-hidden className={switchTrack} data-checked={state}>
      <span className={switchThumb} data-checked={state} />
    </span>
  );
}
