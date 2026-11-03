import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cn } from "../lib/cn.ts";
import { Tooltip } from "./tooltip.tsx";

export type Person = {
  readonly login: string;
  readonly avatarUrl?: string;
};

const fills = ["bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4"] as const;

export function Avatar({ person, index = 0, className }: { person: Person; index?: number; className?: string }) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-tile shrink-0 overflow-hidden rounded-full border-2 border-card select-none",
        fills[index % fills.length],
        className,
      )}
    >
      {person.avatarUrl && <AvatarPrimitive.Image src={person.avatarUrl} alt="" className="size-full object-cover" />}
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center font-sans text-label leading-3 font-semibold text-ink">
        {person.login.slice(0, 2).toUpperCase()}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function NetworkAvatars({ people, className }: { people: ReadonlyArray<Person>; className?: string }) {
  const handles = people.map((person) => `@${person.login}`).join(", ");
  const label = `${people.length} you follow`;
  return (
    <Tooltip
      content={handles}
      aria-label={`${label}: ${handles}`}
      className={cn("flex items-center gap-2 font-sans text-sm leading-4 font-medium", className)}
    >
      <span className="flex -space-x-1.5" aria-hidden>
        {people.slice(0, 4).map((person, index) => (
          <Avatar key={person.login} person={person} index={index} />
        ))}
      </span>
      {label}
    </Tooltip>
  );
}
