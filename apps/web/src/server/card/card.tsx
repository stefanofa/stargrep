import type { CSSProperties, ReactNode } from "react";
import { mark, palette } from "./palette.ts";

// Link preview cards, 1200 by 630, laid out as artboard 12 in design/renders/stargrep. Satori lays them out with flexbox,
// so every box with more than one child says display flex.
export const cardSize = { width: 1200, height: 630 } as const;

const frame: CSSProperties = {
  width: cardSize.width,
  height: cardSize.height,
  boxSizing: "border-box",
  display: "flex",
  gap: 20,
  padding: 36,
  background: palette.background,
  fontFamily: "Inter",
  color: palette.ink,
};

const tile: CSSProperties = { display: "flex", boxSizing: "border-box", borderRadius: 40, background: palette.card };

function Mascot({ size }: { size: number }) {
  return <img src={mark} width={size} height={size} alt="" />;
}

// The one butter tile, with the mascot on its white plate in the corner.
function ButterTile({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        ...tile,
        position: "relative",
        width: 664,
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: "0 44px 44px",
        background: palette.highlight,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 44,
          right: 24,
          width: 260,
          height: 260,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 130,
          background: palette.card,
        }}
      >
        <Mascot size={210} />
      </div>
      {children}
    </div>
  );
}

function Address({ path }: { path: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginTop: "auto",
        fontSize: 26,
        fontWeight: 600,
        color: palette.inkSecondary,
      }}
    >
      {`stargrep.com${path}`}
    </div>
  );
}

// The card for every page without its own: the site's promise, the wordmark, and searches that work on the demo.
export function SiteCard({ query, examples }: { query: string; examples: ReadonlyArray<string> }) {
  return (
    <div style={frame}>
      <ButterTile>
        <div style={{ display: "flex", fontFamily: "Fredoka", fontSize: 62, lineHeight: 1.08, letterSpacing: -1.2 }}>
          search anyone's starred github repos in plain words
        </div>
      </ButterTile>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 20 }}>
        <div style={{ ...tile, alignItems: "center", gap: 14, height: 152, padding: "0 36px" }}>
          <Mascot size={64} />
          <div style={{ fontFamily: "Fredoka", fontSize: 56, letterSpacing: -0.5 }}>stargrep</div>
        </div>
        <div style={{ ...tile, flexDirection: "column", gap: 22, height: 336, padding: "34px 36px" }}>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 500, lineHeight: 1.3 }}>{query}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {examples.map((example) => (
              <div
                key={example}
                style={{
                  display: "flex",
                  padding: "10px 18px",
                  borderRadius: 999,
                  background: palette.accentSoft,
                  fontSize: 21,
                  fontWeight: 500,
                  color: palette.inkSecondary,
                }}
              >
                {example}
              </div>
            ))}
          </div>
        </div>
        <Address path="" />
      </div>
    </div>
  );
}
