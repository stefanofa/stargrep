import type { CSSProperties, ReactNode } from "react";
import { previewSize } from "../../lib/preview.ts";
import { formatCount } from "../../lib/whose.ts";
import type { AccountCardData, TopMatch } from "./account.ts";
import { mark, palette } from "./palette.ts";
import type { TopicCardData } from "./topic.ts";

// Link preview cards, 1200 by 630, laid out as artboard 12 in design/renders/stargrep. Satori lays them out with flexbox,
// so every box with more than one child says display flex.
export const cardSize = previewSize;

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

const tile: CSSProperties = {
  display: "flex",
  flexShrink: 0,
  boxSizing: "border-box",
  borderRadius: 40,
  background: palette.card,
};

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
        flexShrink: 0,
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

// A long login's address would not fit on one line beside the butter tile, so its card names the site alone.
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
      {path.length > 18 ? "stargrep.com" : `stargrep.com${path}`}
    </div>
  );
}

function Pitch() {
  return (
    <div style={{ display: "flex", fontFamily: "Fredoka", fontSize: 62, lineHeight: 1.08, letterSpacing: -1.2 }}>
      search anyone's starred GitHub repos in plain words
    </div>
  );
}

// The card for every page without its own: the site's promise, the wordmark, and searches that work on the demo.
export function SiteCard({ query, examples }: { query: string; examples: ReadonlyArray<string> }) {
  return (
    <div style={frame}>
      <ButterTile>
        <Pitch />
      </ButterTile>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 20 }}>
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

const percent = (share: number) => `${Math.round(share * 100)}%`;

const oneLine: CSSProperties = { display: "block", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };

const clamped = (lines: number): CSSProperties => ({ display: "block", overflow: "hidden", lineClamp: lines });

function Avatar({ login, avatar }: { login: string; avatar: string | null }) {
  const round: CSSProperties = { width: 96, height: 96, borderRadius: 48, flexShrink: 0 };
  return avatar !== null ? (
    <img src={avatar} width={96} height={96} alt="" style={round} />
  ) : (
    <div
      style={{
        ...round,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: palette.avatar,
        fontFamily: "Fredoka",
        fontSize: 40,
      }}
    >
      {login
        .replace(/[^a-z\d]/gi, "")
        .slice(0, 2)
        .toLowerCase()}
    </div>
  );
}

// The language bar of the stars page: the top three in ink, accent and butter, then muted for the rest. The legend under
// it names the second and third, since the first is the big number above.
function Languages({ languages }: { languages: AccountCardData["languages"] }) {
  const fills = [palette.ink, palette.accent, palette.highlight];
  const top = languages.slice(0, fills.length);
  const rest = Math.max(0, 1 - top.reduce((sum, language) => sum + language.share, 0));
  const [first] = top;
  if (first === undefined) return null;
  return (
    <div style={{ ...tile, flexDirection: "column", height: 336, padding: "30px 32px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontFamily: "Fredoka" }}>
        <div style={{ fontSize: 96, lineHeight: 1, letterSpacing: -3 }}>{percent(first.share)}</div>
        <div style={{ ...oneLine, fontSize: 36, flexShrink: 1 }}>{first.name}</div>
      </div>
      <div style={{ display: "flex", gap: 6, height: 24, marginTop: "auto" }}>
        {top.map((language, index) => (
          <div key={language.name} style={{ flexGrow: language.share, borderRadius: 999, background: fills[index] }} />
        ))}
        {rest > 0 && <div style={{ flexGrow: rest, borderRadius: 999, background: palette.muted }} />}
      </div>
      <div style={{ display: "flex", gap: 28, marginTop: 18, height: 30, fontSize: 24, fontWeight: 500 }}>
        {top.slice(1).map((language, index) => (
          <div key={language.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: fills[index + 1] }} />
            <div style={{ display: "flex", gap: 6 }}>
              <span>{language.name}</span>
              <span style={{ color: palette.mutedForeground }}>{percent(language.share)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Match({ top }: { top: TopMatch }) {
  return (
    <div style={{ ...tile, flexDirection: "column", gap: 10, height: 336, padding: "30px 32px" }}>
      <div
        style={{ display: "flex", fontSize: 16, fontWeight: 600, letterSpacing: 1.3, color: palette.mutedForeground }}
      >
        TOP MATCH
      </div>
      <div style={{ ...oneLine, fontFamily: "Fredoka", fontSize: 44, lineHeight: 1.1 }}>{top.name}</div>
      <div style={{ ...oneLine, fontSize: 22, fontWeight: 500, color: palette.mutedForeground }}>{top.owner}</div>
      {top.about !== null && (
        <div
          style={{
            ...clamped(4),
            marginTop: 8,
            fontSize: 22,
            fontWeight: 500,
            lineHeight: 1.4,
            color: palette.inkSecondary,
          }}
        >
          {top.about}
        </div>
      )}
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ ...tile, alignItems: "center", justifyContent: "center", gap: 14, height: 336 }}>
      <Mascot size={64} />
      <div style={{ fontFamily: "Fredoka", fontSize: 56, letterSpacing: -0.5 }}>stargrep</div>
    </div>
  );
}

function Headline({ card }: { card: AccountCardData }) {
  if (card.search !== null)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...oneLine, fontSize: 26, fontWeight: 600, color: palette.inkSecondary }}>
          {`searching @${card.login}'s stars`}
        </div>
        <div style={{ ...clamped(3), fontFamily: "Fredoka", fontSize: 58, lineHeight: 1.08, letterSpacing: -1 }}>
          {`"${card.search.query}"`}
        </div>
      </div>
    );
  if (card.stars === null) return <Pitch />;
  const count = formatCount(card.stars);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontFamily: "Fredoka", fontSize: count.length > 3 ? 150 : 180, lineHeight: 1, letterSpacing: -6 }}>
        {count}
      </div>
      <div style={{ fontFamily: "Fredoka", fontSize: 44, marginTop: 12 }}>
        {card.stars === 1 ? "starred repo" : "starred repos"}
      </div>
    </div>
  );
}

// A login's card: how many repos it starred and its languages, or the search a shared link carries and its best match.
export function AccountCard({ card }: { card: AccountCardData }) {
  const side =
    card.search !== null ? (
      card.search.top !== null ? (
        <Match top={card.search.top} />
      ) : (
        <Wordmark />
      )
    ) : card.languages.length > 0 ? (
      <Languages languages={card.languages} />
    ) : (
      <Wordmark />
    );
  return (
    <div style={frame}>
      <ButterTile>
        <Headline card={card} />
      </ButterTile>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 20 }}>
        <div style={{ ...tile, alignItems: "center", gap: 20, height: 152, padding: "0 28px" }}>
          <Avatar login={card.login} avatar={card.avatar} />
          <div style={{ ...oneLine, fontFamily: "Fredoka", fontSize: card.login.length > 12 ? 32 : 44 }}>
            {`@${card.login}`}
          </div>
        </div>
        {side}
        <Address path={`/${card.login}`} />
      </div>
    </div>
  );
}

// A topic's name fits the butter tile at one size up to 8 letters, and steps down for longer ones.
const topicSize = (topic: string) => (topic.length <= 8 ? 120 : topic.length <= 12 ? 92 : topic.length <= 17 ? 68 : 52);

function TopicHeadline({ card }: { card: TopicCardData }) {
  if (card.search !== null)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...oneLine, fontSize: 26, fontWeight: 600, color: palette.inkSecondary }}>
          {`searching ${card.topic} repos`}
        </div>
        <div style={{ ...clamped(3), fontFamily: "Fredoka", fontSize: 58, lineHeight: 1.08, letterSpacing: -1 }}>
          {`"${card.search.query}"`}
        </div>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", fontSize: 26, fontWeight: 600, color: palette.inkSecondary }}>
        what developers star in
      </div>
      <div
        style={{
          ...oneLine,
          fontFamily: "Fredoka",
          fontSize: topicSize(card.topic),
          lineHeight: 1.05,
          letterSpacing: -2,
        }}
      >
        {card.topic}
      </div>
      <div style={{ display: "flex", fontSize: 26, fontWeight: 500, color: palette.inkSecondary }}>
        {`${formatCount(card.ranked)} ranked · ${formatCount(card.repos)} repos`}
      </div>
    </div>
  );
}

// The topic's three most starred core repos, each with how many developers star it.
function TopRepos({ card }: { card: TopicCardData }) {
  return (
    <div
      style={{ ...tile, flexDirection: "column", justifyContent: "center", gap: 22, height: 336, padding: "28px 32px" }}
    >
      {card.top.map((repo) => (
        <div key={`${repo.owner}/${repo.name}`} style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={{ ...oneLine, fontFamily: "Fredoka", fontSize: 34, lineHeight: 1.15 }}>{repo.name}</div>
            <div style={{ ...oneLine, fontSize: 20, fontWeight: 500, color: palette.mutedForeground }}>
              {repo.owner}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
            <div style={{ fontFamily: "Fredoka", fontSize: 34 }}>{formatCount(repo.devs)}</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: palette.mutedForeground }}>devs</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// A topic's card: its name and counts, and its three most starred repos, or the search a shared link carries and its
// best match.
export function TopicCard({ card }: { card: TopicCardData }) {
  const side =
    card.search !== null ? (
      card.search.top !== null ? (
        <Match top={card.search.top} />
      ) : (
        <Wordmark />
      )
    ) : card.top.length > 0 ? (
      <TopRepos card={card} />
    ) : (
      <Wordmark />
    );
  return (
    <div style={frame}>
      <ButterTile>
        <TopicHeadline card={card} />
      </ButterTile>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 20 }}>
        <div style={{ ...tile, alignItems: "center", gap: 14, height: 152, padding: "0 36px" }}>
          <Mascot size={64} />
          <div style={{ fontFamily: "Fredoka", fontSize: 56, letterSpacing: -0.5 }}>stargrep</div>
        </div>
        {side}
        <Address path={`/topics/${card.topic}`} />
      </div>
    </div>
  );
}
