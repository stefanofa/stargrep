import type { ComponentProps } from "react";

export type IconProps = ComponentProps<"svg">;

// Every icon is decorative line art that takes its color from the text around it.
export const base = { focusable: false, fill: "none" } as const;
