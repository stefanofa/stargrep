const segmentFills = ["bg-foreground", "bg-accent", "bg-highlight"] as const;

export type LanguageShare = {
  readonly name: string;
  readonly share: number;
};

export function LanguageBar({ languages }: { languages: ReadonlyArray<LanguageShare> }) {
  const top = languages.slice(0, segmentFills.length);
  const rest = Math.max(0, 1 - top.reduce((sum, language) => sum + language.share, 0));
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  return (
    <figure className="flex flex-col gap-3">
      <div aria-hidden className="flex h-3 gap-1 overflow-hidden rounded-full">
        {top.map((language, index) => (
          <div key={language.name} className={segmentFills[index]} style={{ flexGrow: language.share }} />
        ))}
        {rest > 0 && <div className="bg-muted" style={{ flexGrow: rest }} />}
      </div>
      <figcaption>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-sm text-secondary-foreground">
          {top.map((language, index) => (
            <li key={language.name} className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${segmentFills[index]}`} />
              {language.name} {percent(language.share)}
            </li>
          ))}
          {rest > 0 && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-muted" />
              other {percent(rest)}
            </li>
          )}
        </ul>
      </figcaption>
    </figure>
  );
}
