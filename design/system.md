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
| `--color-muted-foreground` | #69647E | #9D97B5 | Dates, counts, labels |
| `--color-muted` | #EFEBFA | #2C2840 | Hairlines in tiles, bar tracks, skeletons |
| `--color-border` | #E4DDFA | #2C2840 | Rare outlines: archived tiles |
| `--color-primary` | #1E1B2E | #F2F0FA | Primary buttons (follow, go, claim) |
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
| `--color-switch-track` | #8A84A3 | #77718F | A switch's track when off |
| `--color-switch-thumb` | #FFFFFF | #E4E0F2 | A switch's thumb, off and on |

The butter tile maps the semantic tokens onto these, so a component inside it needs no override: `foreground` becomes `ink`, `accent-strong` and `ring` become `ink-accent`, and `primary` becomes an ink button with white text.

The off switch track measures 3.55:1 against the card and 3.03:1 against a highlighted `muted` menu row in light mode, and 3.56:1 and 3.06:1 in dark mode, so an off switch keeps a visible edge. The thumb measures over 3.5:1 against the off track in both themes.

`--color-muted-foreground` is #69647E, not the #757089 used in the G13 render. On the lilac ground, #757089 at 13px fell just under 4.5:1. The next value, #6E6985, passed on the page and on white but fell to 4.46:1 on `muted` and 4.17:1 on `accent-soft`, where menus and pills put small labels. #69647E measures 4.81:1 on `muted` and 4.51:1 on `accent-soft`.

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
| `--text-lg` | 17px / `--leading-lg` 26px | Reason line in the hero tile, collection notes, text page body |
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
| `--container-narrow` | 620px | Reserved for long text, such as docs and the privacy page. Inside the tile's 30px sides, `--text-lg` body runs about 70 characters a line |
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
| Filter chip | Custom `Chip` | `accent-soft` fill. Language chips select a language, and "archived 38" sits with them when the account starred an archived repo, so the library's filters live in one place. "all" takes every filter off. Removable planner filter chips are planned. |
| Person tile | `Tile` in `apps/web/src/components/person-tile.tsx` | Above the search on anyone else's stars, in place of the landing hero, as the share card shows the person: a 96px avatar (64px on phones), the handle in Fredoka as the page's `h1`, then "616 stars · last starred Nov 6, 2026 · on GitHub ↗". While their stars import it says "stars arriving", and a visitor gets the claim tile beside it. A login GitHub doesn't know shows its handle and two initials. The library on these pages has no count tile. |
| Scope switch | Base UI `Tabs` | The gallery shows your stars, network, and everyone. The app's header has a list of places instead, a plain link each: "your stars" for a signed-in viewer on desktop, "people" for everyone, phones included, and "topics" for everyone on desktop. The footer links "topics" too. A visitor gets a "sign in" button in the header on every page. Phones leave out the star link, so the wordmark, people, and sign-in or the account fit at 390px. |
| People page | `apps/web/src/components/people-page.tsx` | `/people`: the heading with how many people the list holds, the landing's username field, then a card per person in the 4, 2, 1 column grid. A card shows the 56px avatar, the handle in Fredoka, the star count, the language bar, "mostly tagged" with the top 3 topics, each a link to its page when it has one, the last star, and "you share 146 stars" when signed in. The whole card opens their stars. "show more" adds 24 more, with placeholder cards while they load. An empty list says it fills in overnight. Signed in, the people most like you come first, and two chips sort by "most like you" or "recently active". Signed out, the latest star comes first and there is nothing to sort by. |
| Topic page | `apps/web/src/components/topic-page.tsx` | `/topics/nextjs`: the topic's icon in a 56px slot (40px on phones), when it has one, then the topic as the page's heading with its own repo ("vercel/next.js →") beside it, "8,145 repos · 1,057 ranked by developers", a pill search field ("search nextjs repos in plain words") with three example chips on launch topics, then "most starred by developers", 12 rows with "show more" to 48, each with its place, the 36px icon slot, name and owner, one line of summary, and "775 devs · 128k ★", beside "built with nextjs" when 6 or more rank. Under them "people who starred these", 6 faces with "63 of their 910 stars" when 5 qualify, then "related" chips, each led by its topic's icon as a 24px round face when it has one, and "all topics", and a one-line footnote on what devs means. A row opens the repo panel. A search shows "found 12" rows above the lists, and the query lives in `?q=`. While it runs, that tile holds four placeholder rows. A search that fails gets an empty tile with "try again", in the stars page's words. |
| Topics page | `apps/web/src/components/topics-page.tsx` | `/topics`: the heading with how many topics have a page, a field that finds a topic by name as you type, then the 200 most ranked as small tiles in the 4, 2, 1 column grid, each the 36px icon slot, the name in Fredoka and "1,057 ranked · 8,145 repos". The last matches stay on screen while the next name is looked up, and a lookup that fails says so with "try again". |
| Topic icon | `topicIcon` in `packages/api/src/topic-icons.ts`, `topicVisual` in `apps/web/src/lib/topic-visual.ts` | A topic's icon is its brand logo from Simple Icons when `packages/api/scripts/topic-logos.ts` names one, on a white plate in both themes, or on ink when the brand color is too pale for white, as JavaScript's yellow is. Otherwise it is its own repo's icon, when the project's own org owns that repo (react/react, withastro/astro), since a repo merely named like a topic, such as jenkinsci/docker, speaks for no one. Otherwise it has none. The icon slot then shows a monogram, the initials of the topic's first two words or its first two letters ("ml" for machine-learning). The page heading and the related chips show nothing in its place. The topic's card puts the logo on the butter tile's plate in place of the mascot, and keeps the mascot when the topic has no logo. |
| Faces | `Faces` in `apps/web/src/components/landing-hero.tsx` | Under the landing's username field: "or start with", the curated accounts as 32px avatars with handles, two columns on phones, then "see everyone →" to `/people`. The owner pill lists the same accounts after the featured one and ends with "see everyone →". |
| View toggle | Base UI `ToggleGroup` | Two icon toggles, tiles and list, `aria-label` on each. The `stargrep-view` cookie stores the choice for signed-in and signed-out visitors. `?view=` overrides it for a shared link and the first server paint. |
| Deep search | Base UI `Switch` | Gallery only. The app does not rerank results. |
| Monthly picks | Base UI `Menu.CheckboxItem` with `SwitchMark` | In the signed-in account menu. The label, one muted line under it that says what the email is, and the switch's track and thumb on the right. The switch moves at once and moves back with "couldn't save that. try again" when the save fails. |
| Result tile | Custom `ResultItem` in `results.tsx` | The icon slot left of the repo name, an `h3` link, with "owner · language" under it, the reason line with `<mark>`, clamped to four lines with an ellipsis (three in the wide hero tile, whose text is larger, so its row is no taller than a full small tile), then the footer: stars (Fredoka), starred date, alive dot and text, optional network fields in the gallery. In search results, a repo not read yet shows its GitHub description under a "not read yet" chip. A repo whose facts have not arrived yet, with no stars and no push date, shows "reading…" and skeleton text instead of "no pushes yet", and fills in place when they land. |
| Result row (list view) | `ResultItem` with `--radius-md` | The same data in one row. The reason line is clamped to two lines. The icon slot has its own lane, so text starts at the same x in every row, and alive, stars and starred date have fixed lanes. |
| Repo icon slot | Custom | 44px in tiles, 36px in rows and the panel's similar rows, 56px in the repo detail panel, a squircle with `--radius-sm` and a 1.5px `border` edge. One policy function in `apps/web/src/lib/repo-visual.ts` picks what fills it: the repo's own icon on its plate, then the owner's GitHub avatar, for orgs and people alike, then a monogram of two lowercase owner letters in Fredoka on #DCD0FF as the last fallback. In tiles and the panel the slot aligns to the top of the repo name. An image under 64px is never upscaled; it sits at its own size, at most 24px, on a `muted` tile. An image that fails shows the monogram. |
| Matched words | `<mark>` | Styled as `accent-strong`, weight 600, no background. Screen readers and agents get the same spans. |
| Network avatars | Base UI `Avatar`, stacked with -6px overlap | Gallery only. Network is planned. At most four, then "N you follow". `Tooltip` on hover lists handles. Never "friends". |
| Alive | Text with an 8px dot | `success` dot for pushed in the last 30 days, `muted-foreground` dot after that. Archived and deprecated get a label instead. |
| Repo detail panel | Base UI `Dialog`, side right, 520px | Opens on tile click, with its own URL (`?repo=ratatui/ratatui`). Escape closes it. The header puts the repo icon slot left of the name. The app shows the full summary, star count, activity, license, and "open on GitHub". Under the star count and its facts, "also starred by" lists up to six listed people who star the repo, each a 32px avatar and the handle in a link to their stars, then "+N more" in muted text. It fades in once the answer lands and is left out when no one listed stars the repo. Under the summary, "topics" lists the repo's GitHub topics, a chip that opens the topic's page for each one that has a page and plain text for the rest. Under the link to GitHub, two rows of nearby repos load once the panel opens: "also in @login's stars" ("also in your stars" on your own page) and "more like this". Each row lists up to five repos with the 36px icon slot, the name in Fredoka and one line of summary or description, and pulses three placeholder lines while it loads. A row with nothing in it is left out. A repo there opens in the same panel, which scrolls back to its top. Collection and network actions in mockups are planned. |
| Search tile strip | Custom, inside the search tile | One status line on the left, sort and the view toggle on the right, 64px tall, the same in every state, so the controls never move. A 3px rail along the tile's bottom edge shows real progress: stars imported on the first sync, then stars read. The rail is a `progressbar` with the counts as its value text, and only the status label is a live region, so screen readers hear a state change, not every poll. A later sync only says "checking for new stars", and a few new stars read as "2 new stars · reading…" with no rail. On phones the tile docks at the bottom with the strip above the input and one line of detail, and the rail runs along the tile's top edge, inset 32px from each side so the squircle never clips its ends. |
| Sort | Base UI `Menu` | Recently starred, most stars, recently pushed, and best match while searching. |
| Buttons | Custom `Button` | `primary` (ink), `secondary` (accent-soft), `ghost` (white pill). Heights 36 and 44. Always `--radius-full`. |
| Skeleton | skullet | skullet measures the real card with a sample repo and draws one bar per text line, so a placeholder is the size of the card that replaces it. The bars pulse between `muted` and `accent-soft` and hold still under reduced motion. |
| Dead stars | `Tile` in `apps/web/src/components/dead-stars-tile.tsx` | Shown when an account starred at least one archived repo GitHub still serves. "dead stars", the count ("38 of your stars are archived"), the three most starred with their icon slot, name, owner and stars, and a chip that filters the library to them with `?archived=true` and back. A repo in it opens the detail panel. On the landing, and on your own stars when no one's stars are like yours, it is a wide tile under the summary tiles. Otherwise it is one tile of the discover row. |
| Discover row | `LibraryView` with `NewToYouTile` in `apps/web/src/components/new-to-you.tsx` | On anyone else's stars with no query, under the search tile: "new to you" as the page's butter tile, then dead stars, side by side on desktop and stacked on phones. Signed out, the butter tile asks to sign in and names what that gets. Signed in, it lists the three of their stars closest to yours that you haven't starred, and "see all" (`?show=new`) shows the whole answer in place of the months with a chip back. Before your own stars sync it says so. "you share 146 stars" sits in the person tile. The row hides with a query and while their stars import. Its last tile, "stars like @login's", lists the 3 people on the people list whose stars are most like theirs, with "N stars in common", and "more people" to `/people`. Your own stars get a discover row too, once your first sync is done: "people with stars like yours", two tiles wide with up to 6 people and "see everyone", then dead stars. A people tile with no one to list is left out, and with it your own row when you have no dead stars either. |
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
| Someone else's stars, signed in | new to you · you share 333 stars with @ada |
| Empty | nothing matches that |
| Hidden by filters | 12 stars hidden by starred in 2019 · remove that filter |
| Widen scope | search everyone instead |
| Syncing | syncing · 1,204 of 2,431 · about 20 seconds left |
| Unknown user | no GitHub user called junodevv · did you mean junodev? |
| Rate limited | GitHub needs a breather. try again in 2 minutes |
| Unclaimed profile | is this you? · sign in to claim |
| Landing | search anyone's starred GitHub repos in plain words |
| Buttons and links | sign in with GitHub · try again · show more · sign out |

Every string stargrep writes on screen is lowercase, button and link labels included, and so is the first word of a sentence. Proper nouns keep their case: Rust, TypeScript, GitHub. The product name is always lowercase. Repo names and descriptions come from GitHub and keep their own case.

## Motion

- Library tiles enter with opacity and a 4px rise, 200ms, ease-out, when they first appear.
- Search results do not replay an entrance per query. While the next answer is pending the previous results stay, and a result new to the set fades in over 150ms with no stagger. Tiles already on screen never move.
- A navigation that waits on the server for more than 300ms shows a 3px rail along the top of the page, `accent` running over `accent-soft`, until the next page paints. Under reduced motion the rail fills instead of running.
- Loading frames have the final layout: an avatar-sized placeholder in the header, the strip with its controls, and the count, languages and month tiles at their final size, so a reload moves nothing.
- The repo panel slides in from the right in 220ms over a 160ms scrim fade.
- Toggles and tabs: 120ms color change, no movement.
- `prefers-reduced-motion` removes all movement. Library tiles and the repo panel keep their opacity fades. A search result appears at once with no fade, because results change on every query and a fade each time is the motion the setting asks to drop.

## For developers and agents

These rules keep one structure for people, crawlers, and agents.

- **Everything lives in the URL.** The login, query, language, the archived filter (`?archived=true`), sort, view, and open repo: `/junodev?q=rust+library+for+terminal+dashboards&lang=Rust&sort=starred&view=tiles&repo=ratatui/ratatui`. Agents and shared links land on the exact state.
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
| 05 Library | The viewer's stars with no query, grouped by month, language filter, sort |
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
