# Stargrep design system

Stargrep's look is a soft lilac page with white rounded tiles, Fredoka for numbers and headings, Inter for text, one butter-yellow tile per page, and a small yellow star mascot.

This doc is the source of truth for every token below. Renders of each key screen are in `design/renders/stargrep/`.

## Principles in practice

The four experience principles from `docs/product.md` turn into these rules.

- **Fast enough to feel local.** Keyword results render on each keystroke from the local library. Semantic results only append tiles after the ones already on screen. They never reorder a tile the user can see. The loading state is a skeleton in the final grid, shown for milliseconds, never a spinner.
- **Show only what helps the next decision.** A result tile shows the repo, the reason it matched with the matched words marked, whether it is alive, stars, when you starred it, and who you follow starred it. Everything else lives in the repo detail panel.
- **Crafted, not busy.** One butter tile per page. The mascot at most once per screen. No taglines, helper text, or captions. Copy exists only where a string has to exist.
- **No login wall.** Every page in the inventory works signed out except Library and Network. Signed out, the top bar shows "Sign in with GitHub" and network lines are hidden, not replaced with a prompt.

## Tokens

Names follow Tailwind v4 theme variables, so they drop into `@theme` in `packages/ui` and line up with shadcn's semantic names (`background`, `foreground`, `card`, `primary`, `muted`, `accent`, `destructive`, `border`). Stargrep adds `accent-soft`, `accent-strong`, `highlight`, `highlight-edge`, `success`, and `warning`.

### Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-background` | #F5F2FF | #15131F | Page ground |
| `--color-foreground` | #1E1B2E | #F2F0FA | Headings, names, primary text |
| `--color-card` | #FFFFFF | #201D2D | Tiles, inputs, panels |
| `--color-secondary-foreground` | #3A3550 | #C9C4DC | Reason lines and body text in tiles |
| `--color-muted-foreground` | #6E6985 | #9D97B5 | Dates, counts, labels |
| `--color-muted` | #EFEBFA | #2C2840 | Hairlines in tiles, bar tracks, skeletons |
| `--color-border` | #E4DDFA | #2C2840 | Rare outlines: archived and sponsored tiles |
| `--color-primary` | #1E1B2E | #F2F0FA | Primary buttons (Follow, go, Claim) |
| `--color-primary-foreground` | #FFFFFF | #1E1B2E | Text on primary |
| `--color-accent` | #A78BFA | #B9A3FF | Active scope, active toggle, focus ring |
| `--color-accent-soft` | #E9E2FF | #2E2847 | Chips, secondary buttons, avatar fills |
| `--color-accent-strong` | #5B3FCC | #C8B6FF | Matched words, links |
| `--color-highlight` | #FFD84D | #FFD84D | The one hero tile per page, the mascot |
| `--color-highlight-edge` | #E9B826 | #E9B826 | Mascot outline |
| `--color-success` | #2BB673 | #3CCB86 | Alive dot |
| `--color-warning` | #E8A317 | #F0B43A | Syncing, stale |
| `--color-destructive` | #E5484D | #FF6B70 | Errors only |

Text on the butter tile always uses the light-mode ink (#1E1B2E) and light-mode `accent-strong` (#5B3FCC) for matches, in both themes. Light `accent-strong` on butter has enough contrast; the dark value does not.

Avatar fills for initials avatars rotate through #FBD9C4, #DCD0FF, #F9D4E6, #CDEEDC with ink text. Real GitHub avatars replace them when available.

`--color-muted-foreground` is #6E6985, not the #757089 used in the G13 render. On the lilac ground, #757089 at 13px fell just under 4.5:1. The key screens already use the new value.

### Type

| Token | Value | Use |
|---|---|---|
| `--font-display` | Fredoka 600 | Numbers, headings, wordmark, repo names in tiles |
| `--font-sans` | Inter 400, 500, 600 | Everything else |
| `--font-mono` | JetBrains Mono | Code, CLI snippets, API keys. Not used in the main screens |
| `--text-label` | 11px, uppercase, `--tracking-caps` 0.08em | Small labels (STARRED, ARCHIVED, SPONSORED) |
| `--text-sm` | 13px / 16px | Meta lines in small tiles and list rows |
| `--text-meta` | 14px / `--leading-sm` 18px | Owner lines in small tiles, meta lines in the hero tile, chips, tabs, buttons |
| `--text-base` | 15px / `--leading-base` 22px | Reason lines in small tiles, body |
| `--text-lg` | 17px / `--leading-lg` 26px | Reason line in the hero tile, collection notes |
| `--text-xl` | 24px / `--leading-xl` 32px | The query in the search tile |
| `--text-name` | 26px / 30px | Repo names in small tiles |
| `--text-2xl` | 30px / 34px | Tile numbers |
| `--text-3xl` | 36px | Wordmark, page headings, the repo name in the hero tile |
| `--text-4xl` | 40px / 44px | The star count in the hero tile |
| `--text-display` | 52px | Hero tile headline ("found 5!") |
| `--text-hero` | 120px | The one big number per page ("412") |

Display sizes take `--tracking-tight` (-0.02em). Headings in Fredoka are lowercase ("found 5!", "pinned", "similar taste", "best rust tui libraries"). Nothing goes under 13px except uppercase labels at 11px.

Load Fredoka (600 only) and Inter (variable) from the app, with `font-display: swap`. Two families and four weights in total.

### Space, radius, layout

| Token | Value | Use |
|---|---|---|
| `--spacing-1` to `--spacing-4` | 4, 8, 12, 16px | Inside components |
| `--spacing-gap` | 20px | Gap between tiles, and between sections |
| `--spacing-tile-sm` | 22px | Right and bottom padding of small tiles |
| `--spacing-tile-top` | 26px | Top padding of the search tile and the hero tile |
| `--spacing-6` | 24px | Top and left padding of small tiles, bottom padding of the search tile and the hero tile |
| `--spacing-tile` | 28px | Side padding of the search tile and list rows |
| `--spacing-tile-lg` | 30px | Side padding of the hero and summary tiles |
| `--spacing-12`, `-16`, `-24` | 48, 64, 96px | Page top and bottom |
| `--radius-sm` | 12px | Repo monogram squares |
| `--radius-md` | 20px | List rows, menus, popovers, tooltips |
| `--radius-tile` | 28px | Tiles, the search tile, the detail panel |
| `--radius-full` | 999px | Chips, buttons, toggles, avatars |
| `--container-page` | 1200px | Page width |
| `--container-narrow` | 720px | Reserved for long text, such as docs and the privacy page |
| `--opacity-archived` | 60% | The star and the alive dot on archived and deprecated tiles |

The grid is 4 columns at 1024px and up, 2 columns from 640px, and 1 column below. On phones the search input moves to the bottom of the screen, under the thumb, with chips just above it (artboard 18).

Small tiles take 24px padding at the top and left and 22px at the right and bottom. The hero tile takes 26px at the top, 30px at the sides, and 24px at the bottom. The search tile takes 26px at the top, 28px at the sides, and 24px at the bottom. A list row takes 20px (`--spacing-gap`) at the top and bottom and 28px at the sides.

Tiles have no borders and no shadows. Separation comes from the lilac ground showing between white tiles. The only shadow in the system is on the repo detail panel, over a lilac scrim.

## Components

Every component is a stock shadcn component on Base UI, restyled with the tokens above. Nothing below needs a new primitive. The custom pieces are the mascot, the language bar, and the starred-by-week grid.

| Stargrep piece | Built from | Notes |
|---|---|---|
| Tile | shadcn `Card` | Variants: `default` (card), `highlight` (butter, one per page), `quiet` (border, transparent, for sponsored), `archived` (no border, muted text, `--opacity-archived` on the star and the alive dot, so text keeps its contrast). Radius `--radius-tile`. No shadow. |
| Search tile | `Card` + `Input` | The input is borderless, `--text-xl`, inside a white tile. `/` focuses it from anywhere. The query lives in the URL. |
| Filter chip | `Badge` + `Button` (icon, size xs) | `accent-soft` fill. The x button removes the filter. Backspace in an empty input removes the last chip. |
| Scope switch | Base UI `Tabs` | Your stars, Network, Everyone. A white pill track, the active tab on `accent`. Each tab is a link, so the scope is in the URL. |
| View toggle | Base UI `ToggleGroup` | Two icon toggles, tiles and list, `aria-label` on each. The choice persists per user (local storage signed out, profile setting signed in) and in `?view=`. |
| Deep search | Base UI `Switch` | Off by default. It adds about a second. When on, the hero tile shows the mascot thinking until results rerank. |
| Result tile | `Card` | Repo name as an `h3` link, owner under it, the reason line with `<mark>`, then the footer: stars (Fredoka), starred date, alive dot and text, network avatars and "N you follow". |
| Result row (list view) | `Card` with `--radius-md` | The same data in one row with fixed lanes for alive, stars, starred date, and network, so columns align. |
| Matched words | `<mark>` | Styled as `accent-strong`, weight 600, no background. Screen readers and agents get the same spans. |
| Network avatars | shadcn `Avatar`, stacked with -6px overlap | At most four, then "N you follow". `Tooltip` on hover lists handles. Never "friends". |
| Alive | Text with an 8px dot | `success` dot for pushed in the last 30 days, `muted-foreground` dot after that. Archived and deprecated get a label instead. |
| Repo detail panel | shadcn `Sheet` (Base UI `Dialog`), side right, 520px | Opens on tile click, with its own URL (`?repo=ratatui/ratatui`). Escape closes it. Contents: summary, one big star count, alive, release, license, who you follow starred it, three "also starred", Open on GitHub, Add to collection. |
| Sort | Base UI `Menu` (shadcn `DropdownMenu`) | Recently starred, most stars, recently pushed. |
| Buttons | shadcn `Button` | `primary` (ink), `secondary` (accent-soft), `ghost` (white pill). Heights 36 and 44. Always `--radius-full`. |
| Progress (syncing) | Base UI `Progress` | A 4px bar in `accent` on `muted`, with "1,204 of 2,431" and the time left in text. |
| Skeleton | shadcn `Skeleton` | `muted` blocks in the exact grid of the final result. |
| Language bar | Custom, divs in a flex row | Segments in ink, `accent`, `highlight`, then `muted` for the rest. A text legend under it, so color is never the only carrier. |
| Starred-by-week grid | Custom, an SVG or CSS grid | 52 columns by 7 rows, five steps from `muted` to `accent-strong`, with one ink step for the busiest weeks. `role="img"` with a text summary, and the counts available as a hidden table. |
| Mascot | Custom React component, inline SVG | `<Mascot mood="happy" size={…} />`. See below. `aria-hidden`. |
| Sponsored | `Card` variant `quiet` + `Badge` "sponsored" | Never butter, never first, one per page at most. Never in API or MCP results. |

## The mascot

The SVG is in `design/assets/mascot.svg`: a five-point star in `highlight` with a `highlight-edge` outline, two dot eyes, and a small smile. It has no name yet. "Pip", its working name, collides with Python's package manager in a developer product, so copy never names it until the name is settled.

- **At most once per screen,** inside one tile or one state. Never on a list row or a result tile.
- **Moods change only the face.** The body stays identical.
  - Happy smile: results, profile milestone.
  - Closed happy eyes: syncing, saved, shared.
  - Magnifying glass at its side: landing, network search, loading.
  - Flat mouth: empty results.
  - Round "o" mouth: errors, the unclaimed "is this you?" tile.
- **Motion:** one blink when results land. One small bounce on a milestone. No idle animation, and none at all under `prefers-reduced-motion`.

## Voice

Lowercase, short, friendly, a little cheeky. Only in strings that must exist.

| Moment | String |
|---|---|
| Results count | found 5! |
| Count detail | of your 2,431 stars |
| Network | 4 you follow |
| Empty | nothing matches that |
| Hidden by filters | 12 stars hidden by starred in 2019 · remove that filter |
| Widen scope | search everyone instead |
| Syncing | syncing · 1,204 of 2,431 · about 20 seconds left |
| Unknown user | no github user called junodevv · did you mean junodev? |
| Rate limited | github needs a breather. try again in 2 minutes |
| Unclaimed profile | is this you? · sign in to claim |
| Landing | search anyone's github stars in plain words |

Proper nouns keep their case inside lowercase copy (Rust, TypeScript, GitHub in buttons such as "Sign in with GitHub").

## Motion

- Tiles enter with opacity and a 6px rise, 200ms, spring easing, 30ms stagger, once per query.
- Semantic results append at the end of the grid with the same entrance. Tiles already on screen never move.
- The repo panel slides in from the right in 220ms over a 160ms scrim fade.
- Toggles and tabs: 120ms color change, no movement.
- `prefers-reduced-motion` removes all movement and keeps the opacity fades.

## For developers and agents

These rules keep one structure for people, crawlers, and agents.

- **Everything lives in the URL.** The query, the scope, the filters, the view, and the open repo: `/junodev?q=rust+library+for+terminal+dashboards&lang=rust&starred=2025&topic=tui&view=tiles&repo=ratatui/ratatui`. Agents and shared links land on the exact state.
- **Results are an ordered list.** Use `<ol>` of `<article>`, each with an `h3` repo link, the reason in a `p` with `<mark>`, and the meta in a `dl`. The tile and list views change CSS only, not markup.
- **The UI and MCP share one shape.** Each result's fields (repo, reason, alive, stars, starred_at, network) are the fields `search_stars` returns, so the web and MCP share one shape.
- **SEO pages add structured data.** "Best X" pages add `ItemList` JSON-LD. Profiles add `ProfilePage`.
- **Color never carries meaning alone.** Archived, deprecated, sponsored, and alive always have a text label.
- **Focus is always visible.** A 2px `accent` ring with a 2px offset on every focusable element.

## Screen inventory

PNGs are in `design/renders/stargrep/`.

| Artboard | What it shows |
|---|---|
| 01 Landing | Signed out. One heading, the github.com/ username input, the mascot, three real example searches |
| 02 Search · tiles | The hero search in tiles view |
| 03 Search · list | The same results in list view |
| 04 Search · dark | Tiles view in dark mode |
| 05 Library | Your stars with no query, grouped by month, language filter, sort |
| 06 Network search | Scope Network, "auth library for next.js", faces first |
| 07 Repo detail panel | ratatui in the right-side panel over search |
| 08 Profile · claimed | @junodev seen by a signed-in visitor |
| 09 Profile · unclaimed | @mira-lab, built from public data, with the claim tile |
| 10 Collection | "my rust tui stack", notes first |
| 11 Best X page | "best rust tui libraries", ranked, with one quiet sponsored slot |
| 12 Taste card · OG 1200×630 | The link preview image |
| 13 Taste card · story 1080×1920 | The vertical share card |
| 14 State · empty | No results, with the filter that hid them |
| 15 State · loading | Skeleton tiles in the final grid |
| 16 State · syncing | First visit, partial results while stars sync |
| 17 State · error | Unknown username and GitHub rate limit |
| 18 Mobile · search 390×844 | Thumb-reachable input at the bottom |
| 19 Mobile · profile 390×844 | The profile on a phone |

## Open items

- **The mascot's name.** "Pip" collides with Python's pip, so copy avoids naming it for now.
- **Invented numbers in the mocks.** Follower counts, collection counts on the "best X" page, weekly star counts, the "212 more in Everyone" count, and some star counts (fzf, uv) are placeholders. The repos, owners, and descriptions are real.
- **The view toggle default.** The mocks default to tiles. Data on how far people scroll should decide whether list becomes the default past a number of results.
- **A dark mode Paper pass.** Only artboard 04 is in dark mode. The dark tokens above cover every component, but the profile and taste cards have not been checked in dark mode.
