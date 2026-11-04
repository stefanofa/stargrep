import type { ReactNode } from "react";

export function Page({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-page flex-col gap-[30px] px-4 pt-6 pb-16 sm:pt-[30px] min-[1232px]:px-0">
      <header className="flex min-h-11 items-center justify-between gap-4">{header}</header>
      <main className="flex flex-col gap-gap">{children}</main>
    </div>
  );
}
