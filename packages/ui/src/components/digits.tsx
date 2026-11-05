// Fredoka has no tabular figures, so each digit gets a cell as wide as its widest one (577 of 1000 units).
export function Digits({ children }: { children: string }) {
  return (
    <>
      <span className="sr-only">{children}</span>
      <span aria-hidden>
        {Array.from(children, (char, index) =>
          /\d/.test(char) ? (
            <span key={index} className="inline-block w-[0.58em] text-center">
              {char}
            </span>
          ) : (
            char
          ),
        )}
      </span>
    </>
  );
}
