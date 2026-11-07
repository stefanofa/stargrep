# Stargrep design system

Stargrep's look is a soft lilac page with white rounded tiles, Fredoka for numbers and headings, Inter for text, one butter-yellow tile per page, and a small yellow star mascot.

`packages/ui/src/theme.css` defines the implemented tokens. This doc records their use and the design mockups in `design/renders/stargrep/`. Mockups include screens that the app does not implement.

## Principles in practice

The current search screens follow these rules.

- **Fast enough to feel local.** Keyword results render on each keystroke from the local library. Semantic results only append tiles after the ones already on screen. They never reorder a tile the user can see. The loading state is a skeleton in the final grid.
- **Show only what helps the next decision.** A result tile shows the repo, the reason it matched with the matched words marked, whether it is alive, stars, and when you starred it. Everything else lives in the repo detail panel.
- **Crafted, not busy.** One butter tile per page. The star mark sits in the header and at most once more per screen. No taglines, helper text, or captions. Copy exists only where a string has to exist.
- **No login wall.** Public stars pages work signed out. The current app has no network page.

## Tokens

Names follow Tailwind v4 theme variables, so they drop into `@theme` in `packages/ui` and use semantic names (`background`, `foreground`, `card`, `primary`, `muted`, `accent`, `destructive`, `border`). Stargrep adds `accent-soft`, `accent-strong`, `highlight`, `highlight-edge`, `success`, and `warning`.

### Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-background` | #F5F2FF | #15131F | Page ground |
| `--color-foreground` | #1E1B2E | #F2F0FA | Headings, names, primary text |
| `--color-card` | #FFFFFF | #201D2D | Tiles, inputs, panels |
| `--color-secondary-foreground` | #3A3550 | #C9C4DC | Reason lines and body text in tiles |
| `--color-muted-foreground` | #6E6985 | #9D97B5 | Dates, counts, labels |
| `--color-muted` | #EFEBFA | #2C2840 | Hairlines in tiles, bar tracks, skeletons |
| `--color-border` | #E4DDFA | #2C2840 | Rare outlines: archived tiles |
| `--color-primary` | #1E1B2E | #F2F0FA | Primary buttons (Follow, go, Claim) |
| `--color-primary-foreground` | #FFFFFF | #1E1B2E | Text on primary |
| `--color-accent` | #A78BFA | #B9A3FF | Active scope, active toggle |
| `--color-accent-soft` | #E9E2FF | #2E2847 | Chips, secondary buttons, avatar fills |
| `--color-accent-strong` | #5B3FCC | #C8B6FF | Matched words, links |
| `--color-highlight` | #FFD84D | #FFD84D | The one hero tile per page, the mascot |
| `--color-highlight-edge` | #E9B826 | #E9B826 | Mascot outline |
| `--color-success` | #2BB673 | #3CCB86 | Alive dot |
| `--color-warning` | #E8A317 | #F0B43A | Syncing, stale |
| `--color-destructive` | #E5484D | #FF6B70 | Errors only |
| `--color-ring` | #5B3FCC | #B9A3FF | Focus ring |

Text on the butter tile always uses the light-mode ink (#1E1B2E) and light-mode `accent-strong` (#5B3FCC) for matches, in both themes. Light `accent-strong` on butter has enough contrast; the dark value does not.

Avatar fills for initials avatars rotate through #FBD9C4, #DCD0FF, #F9D4E6, #CDEEDC with ink text. Real GitHub avatars replace them when available.

These color tokens back the rules above:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-ink` | #1E1B2E | #1E1B2E | Text and the primary button on the butter tile |
| `--color-ink-secondary` | #3A3550 | #3A3550 | Secondary text on the butter tile |
| `--color-ink-accent` | #5B3FCC | #5B3FCC | Matches and the focus ring on the butter tile |
| `--color-avatar-1` to `-4` | #FBD9C4, #DCD0FF, #F9D4E6, #CDEEDC | same | Initials avatars and the repo monogram |
| `--color-plate` | #FFFFFF | #FFF6D6 | The disc behind the mascot on the butter tile |
| `--color-scrim` | #7860D2 at 26% | #0B0A12 at 60% | Behind the repo detail panel |
| `--color-image-edge` | black at 10% | white at 10% | The 1px outline on images |

The butter tile maps the semantic tokens onto these, so a component inside it needs no override: `foreground` becomes `ink`, `accent-strong` and `ring` become `ink-accent`, and `primary` becomes an ink button with white text.

`--color-muted-foreground` is #6E6985, not the #757089 used in the G13 render. On the lilac ground, #757089 at 13px fell just under 4.5:1. The key screens already use the new value.

### Type

| Token | Value | Use |
|---|---|---|
| `--font-display` | Fredoka 600 | Numbers, headings, wordmark, repo names in tiles |
| `--font-sans` | Inter 400, 500, 600 | Everything else |
| `--font-mono` | JetBrains Mono | Code, CLI snippets, API keys. Not used in the main screens |
| `--text-label` | 11px, uppercase, letter spacing 0.08em | Small labels (STARRED, ARCHIVED) |
| `--text-sm` | 13px / 16px | Meta lines in small tiles and list rows |
| `--text-meta` | 14px / `--leading-sm` 18px | Owner lines in small tiles, meta lines in the hero tile, chips, tabs, buttons |
| `--text-base` | 15px / `--leading-base` 22px | Reason lines in small tiles, body |
| `--text-lg` | 17px / `--leading-lg` 26px | Reason line in the hero tile, collection notes |
| `--text-title` | 22px / 28px | Repo names in list rows, empty tile headings on phones, the monogram in the panel |
| `--text-xl` | 24px / `--leading-xl` 32px | The query in the search tile |
| `--text-name` | 26px / 30px | Repo names in small tiles |
| `--text-2xl` | 30px / 34px | Tile numbers |
| `--text-3xl` | 36px | Wordmark, page headings, the repo name in the hero tile |
| `--text-4xl` | 40px / 44px | The star count in the hero tile |
| `--text-display` | 52px | Hero tile headline ("found 5!") |
| `--text-hero` | 120px | The one big number per page ("412") |

Display sizes take `--tracking-tight` (-0.02em). Names and headings below display size take `--tracking-snug` (-0.01em). Headings in Fredoka are lowercase ("found 5!", "pinned", "similar taste", "best rust tui libraries"). Nothing goes under 13px except uppercase labels at 11px.

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
| `--radius-xs` | 8px | The `/` key hint in the search tile |
| `--radius-sm` | 12px | Repo monogram squares |
| `--radius-md` | 20px | List rows, menus, popovers, tooltips |
| `--radius-tile` | 28px | Tiles, the search tile, the detail panel |
| `--radius-full` | 999px | Chips, buttons, toggles, avatars |
| `--radius-item` | `--radius-md` minus 7.5px | Menu items, concentric inside a menu's 1.5px border and 6px padding |
| `--container-page` | 1200px | Page width |
| `--container-narrow` | 720px | Reserved for long text, such as docs and the privacy page |
| `--opacity-archived` | 60% | The star and the alive dot on archived and deprecated tiles |

Cards take squircle corners. Add `squircle` next to the card's `rounded-*` token class, such as `rounded-tile` or `rounded-md`; an arbitrary radius does not scale and comes out shallower: tiles, result rows, the detail panel, and the boxes inside it. Where the browser supports `corner-shape`, the corner becomes a squircle and its radius grows 1.84 times, so it cuts into the card as deep as the round corner did. Other browsers keep the round corner at the token's radius. Chips, buttons, toggles, menus, and tooltips stay round.

The grid is 4 columns at 1024px and up, 2 columns from 640px, and 1 column below. On phones the search input moves to the bottom of the screen, under the thumb, with chips just above it (artboard 18).

Small tiles take 24px padding at the top and left and 22px at the right and bottom. The hero tile takes 26px at the top, 30px at the sides, and 24px at the bottom. The search tile takes 26px at the top, 28px at the sides, and 24px at the bottom. A list row takes 20px (`--spacing-gap`) at the top and bottom and 28px at the sides.

Tiles have no borders and no shadows. Separation comes from the lilac ground showing between white tiles. Two shadows exist: `--shadow-panel` on the repo detail panel, over a lilac scrim, and `--shadow-dock` on the search tile while it docks at the bottom of a phone screen.

## Components

Components live in `packages/ui/src/components`. Interactive controls use Base UI. Tiles, result layouts, the mascot, language bars, and the starred-by-week grid are custom components. Some controls exist only in the gallery.

| Stargrep piece | Built from | Notes |
|---|---|---|
| Tile | Custom `Tile` | Variants: `default` (card), `highlight` (butter, one per page), `quiet` (border, transparent), `archived` (no border, muted text, `--opacity-archived` on the star and the alive dot, so text keeps its contrast). Radius `--radius-tile`. No shadow. |
| Search tile | Custom `SearchTile` | The input is borderless, `--text-xl`, inside a white tile. `/` focuses it from anywhere. The query lives in the URL. |
| Filter chip | Custom `Chip` | `accent-soft` fill. Language chips select a language. Removable planner filter chips are planned. |
| Scope switch | Base UI `Tabs` | The gallery shows Your stars, Network, and Everyone. The app currently shows one link to the viewer's stars. |
| View toggle | Base UI `ToggleGroup` | Two icon toggles, tiles and list, `aria-label` on each. The `stargrep-view` cookie stores the choice for signed-in and signed-out visitors. `?view=` overrides it for a shared link and the first server paint. |
| Deep search | Base UI `Switch` | Gallery only. The app does not rerank results. |
| Result tile | Custom `ResultItem` in `results.tsx` | The icon slot left of the repo name, an `h3` link, with "owner · language" under it, the reason line with `<mark>`, clamped to four lines with an ellipsis (three in the wide hero tile, whose text is larger, so its row is no taller than a full small tile), then the footer: stars (Fredoka), starred date, alive dot and text, optional network fields in the gallery. In search results, a repo not read yet shows its GitHub description under a "not read yet" chip. A repo whose facts have not arrived yet, with no stars and no push date, shows "reading…" and skeleton text instead of "no pushes yet", and fills in place when they land. |
| Result row (list view) | `ResultItem` with `--radius-md` | The same data in one row. The reason line is clamped to two lines. The icon slot has its own lane, so text starts at the same x in every row, and alive, stars and starred date have fixed lanes. |
| Repo icon slot | Custom | 44px in tiles, 36px in rows, 56px in the repo detail panel, a squircle with `--radius-sm` and a 1.5px `border` edge. One policy function in `apps/web/src/lib/repo-visual.ts` picks what fills it: the repo's own icon on its plate, then the owner's GitHub avatar, for orgs and people alike, then a monogram of two lowercase owner letters in Fredoka on #DCD0FF as the last fallback. In tiles and the panel the slot aligns to the top of the repo name. An image under 64px is never upscaled; it sits at its own size, at most 24px, on a `muted` tile. An image that fails shows the monogram. |
| Matched words | `<mark>` | Styled as `accent-strong`, weight 600, no background. Screen readers and agents get the same spans. |
| Network avatars | Base UI `Avatar`, stacked with -6px overlap | Gallery only. Network is planned. At most four, then "N you follow". `Tooltip` on hover lists handles. Never "friends". |
| Alive | Text with an 8px dot | `success` dot for pushed in the last 30 days, `muted-foreground` dot after that. Archived and deprecated get a label instead. |
| Repo detail panel | Base UI `Dialog`, side right, 520px | Opens on tile click, with its own URL (`?repo=ratatui/ratatui`). Escape closes it. The header puts the repo icon slot left of the name. The app shows the full summary, star count, activity, license, and Open on GitHub. Collection and network actions in mockups are planned. |
| Search tile strip | Custom, inside the search tile | One status line on the left, sort and the view toggle on the right, 64px tall, the same in every state, so the controls never move. A 3px rail along the tile's bottom edge shows real progress: stars imported on the first sync, then stars read. The rail is a `progressbar` with the counts as its value text, and only the status label is a live region, so screen readers hear a state change, not every poll. A later sync only says "checking for new stars", and a few new stars read as "2 new stars · reading…" with no rail. On phones the tile docks at the bottom with the strip above the input and one line of detail, and the rail runs along the tile's top edge, inset 32px from each side so the squircle never clips its ends. |
| Sort | Base UI `Menu` | Recently starred, most stars, recently pushed, and best match while searching. |
| Buttons | Custom `Button` | `primary` (ink), `secondary` (accent-soft), `ghost` (white pill). Heights 36 and 44. Always `--radius-full`. |
| Skeleton | skullet | skullet measures the real card with a sample repo and draws one bar per text line, so a placeholder is the size of the card that replaces it. The bars pulse between `muted` and `accent-soft` and hold still under reduced motion. |
| Language bar | Custom, divs in a flex row | Segments in ink, `accent`, `highlight`, then `muted` for the rest. A text legend under it, so color is never the only carrier. |
| Starred-by-week grid | Custom, an SVG or CSS grid | 52 columns by 7 rows, five steps from `muted` to `accent-strong`, with one ink step for the busiest weeks. `role="img"` with a text summary, and the counts available as a hidden table. |
| Mark | Custom React component, inline SVG | `<Pip pose="idle" size={…} />`. See below. `aria-hidden`. |

## The mascot

The mark is a five-point star in `highlight` with a `highlight-edge` outline and two eyes. Its working name, Pip, collides with Python's package manager in a developer product, so copy never names it until the name is settled.

The star is ours. The eyes, the poses and the idle motion come from [Blobatar](https://github.com/Alain00/blobatar), which has no star silhouette. `packages/ui/scripts/bake-pip.ts` gives the star its own face, a circle inside the drawn star, and fits the eyes to it with Blobatar's `faceFit` and `superellipse`. Blobatar keeps those two private, so they are vendored from 2.7.0 in `packages/ui/scripts/blobatar-face.ts` with its MIT license. The bake writes the eyes, the idle timings from the public `idleSeeds` and each pose's CSS variables to `packages/ui/src/mark/pip.gen.ts`. Blobatar's `motion.css` animates markup that follows its class contract (`mo-root`, `mo-breathe`, `mo-bob`, `mo-eyes`, `mo-eye`). A pose changes only CSS variables on the root, so the stylesheet morphs between poses and the page ships no Blobatar JavaScript. Blobatar is pinned to one exact version. `packages/ui/test/pip.test.tsx` fails if an upgrade changes the mark, `pip-geometry.test.ts` keeps every eye inside the star in every pose, and `motion-contract.test.tsx` fails if `motion.css` stops styling a class or variable Pip uses.

- **One pose per state.** Idle while browsing and on results. Happy while stars import. Thinking while they are read, and while a search waits on the server. Surprised for a moment when results by meaning land. Unsure when nothing matches yet but reading continues. Sad when nothing matches at all. Scared when a sync or search fails.
- **Where it appears.** The header, beside the wordmark: 40px on desktop, 30px on phones. The count tile, the empty tiles and the landing tile. Never on a list row or a result tile.
- **Motion:** it breathes, bobs, blinks and glances, with timings drawn from its seed. `prefers-reduced-motion` stops all of it and keeps the pose.

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

- Library tiles enter with opacity and a 4px rise, 200ms, ease-out, when they first appear.
- Search results do not replay an entrance per query. While the next answer is pending the previous results stay, and a result new to the set fades in over 150ms with no stagger. Tiles already on screen never move.
- Loading frames have the final layout: an avatar-sized placeholder in the header, the strip with its controls, and the count, languages and month tiles at their final size, so a reload moves nothing.
- The repo panel slides in from the right in 220ms over a 160ms scrim fade.
- Toggles and tabs: 120ms color change, no movement.
- `prefers-reduced-motion` removes all movement and keeps the opacity fades.

## For developers and agents

These rules keep one structure for people, crawlers, and agents.

- **Everything lives in the URL.** The login, query, language, sort, view, and open repo: `/junodev?q=rust+library+for+terminal+dashboards&lang=Rust&sort=starred&view=tiles&repo=ratatui/ratatui`. Agents and shared links land on the exact state.
- **Results are an ordered list.** Use `<ol>` of `<article>`, each with an `h3` repo link, the reason in a `p` with `<mark>`, and the meta in a `dl`. The tile and list views change CSS only, not markup.
- **The UI derives presentation from the API.** `packages/api/src/contract.ts` defines wire fields. The web app derives its tiles and rows from those fields. The MCP tool is named `search`.
- **Color never carries meaning alone.** Archived, deprecated, and alive always have a text label.
- **Focus is always visible.** A 2px `ring` outline with a 2px offset on every focusable element. In light mode the ring is `accent-strong`, since `accent` falls under 3:1 on white, lilac and butter. On the butter tile it is light-mode `accent-strong` in both themes.

## Mockup inventory

These are design references, not a list of shipped routes. Network, profiles with taste cards, collections, and discovery pages are planned. PNGs are in `design/renders/stargrep/`.

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
| 11 Best X page | "best rust tui libraries", ranked |
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
- **The view toggle default.** Tiles are the default when neither the URL nor the view cookie chooses a view.
- **A dark mode Paper pass.** Only artboard 04 is in dark mode. The dark tokens above cover every component, but the profile and taste cards have not been checked in dark mode.
