import { Chip } from "./chip.tsx";

export function RephraseChips({
  phrases,
  onPick,
}: {
  phrases: ReadonlyArray<string>;
  onPick: (phrase: string) => void;
}) {
  if (phrases.length === 0) return null;
  return (
    <ul aria-label="Try other words" className="flex flex-wrap justify-center gap-2 pt-2 sm:justify-start">
      {phrases.map((phrase) => (
        <li key={phrase}>
          <Chip type="button" onClick={() => onPick(phrase)}>
            {phrase}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
