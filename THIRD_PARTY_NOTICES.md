# Third-party notices

Stargrep includes or quotes the material below. Each keeps its own license.

## Vendored source in `repos/`

`repos/` holds read-only copies of dependency source for reference. Git does not track them. `bun scripts/sync-repos.ts` fetches each one at the tag and commit that `repos/VENDORED.json` pins, along with its license files.

| Project | Path | License | Notices |
|---|---|---|---|
| Effect | `repos/effect` | MIT, [LICENSE](https://github.com/Effect-TS/effect/blob/506eef143bcc1750ce58920aac1e45da7265d103/LICENSE) | [packages/effect/THIRD_PARTY_NOTICES.md](https://github.com/Effect-TS/effect/blob/506eef143bcc1750ce58920aac1e45da7265d103/packages/effect/THIRD_PARTY_NOTICES.md) |
| oRPC | `repos/orpc` | MIT, [LICENSE](https://github.com/middleapi/orpc/blob/221882c571aac2c1752f939c5cfd3aca303e1317/LICENSE) | None |
| Alchemy | `repos/alchemy` | Apache 2.0, [LICENSE](https://github.com/alchemy-run/alchemy-effect/blob/d0b4a3326718309793459160e94b35abee517b23/LICENSE) | [NOTICE](https://github.com/alchemy-run/alchemy-effect/blob/d0b4a3326718309793459160e94b35abee517b23/NOTICE), [THIRD_PARTY_LICENSES.md](https://github.com/alchemy-run/alchemy-effect/blob/d0b4a3326718309793459160e94b35abee517b23/THIRD_PARTY_LICENSES.md) |

## Fonts

The web app ships these fonts. Each license file sits next to the font files.

| Font | Files | License |
|---|---|---|
| Fredoka, copyright 2016 The Fredoka Project Authors | `packages/ui/src/fonts/fredoka-*.woff2` | SIL Open Font License 1.1, [fredoka-OFL.txt](packages/ui/src/fonts/fredoka-OFL.txt) |
| Inter, copyright 2016 The Inter Project Authors | `packages/ui/src/fonts/inter-*.woff2` | SIL Open Font License 1.1, [inter-OFL.txt](packages/ui/src/fonts/inter-OFL.txt) |

## Data

| Material | Path | Source and license |
|---|---|---|
| GitHub topic names, labels, aliases, and descriptions | `packages/core/seeds/github-explore.json` | Topic names, display names, aliases, and short descriptions from GitHub Explore ([github/explore](https://github.com/github/explore)) by GitHub, Inc. and contributors, under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Changed: descriptions joined onto one line and cut at 400 characters, labels cut at 120, and a display name's (disambiguation) suffix dropped. The file records the upstream commit. |
| Public GitHub repo metadata | `evals/fixtures/*.jsonl` | Names, descriptions, topics, and languages of public GitHub repos, as the GitHub API returns them. The summaries and vectors are Stargrep's own. |

## Test fixtures

| Material | Path | Source and license |
|---|---|---|
| create-next-app `favicon.ico` | `packages/core/src/icons/fixtures/next-favicon-current.ico` | From [Next.js](https://github.com/vercel/next.js), Copyright (c) 2025 Vercel, Inc., under the MIT license. A test checks that Stargrep skips this template icon by its exact blob ID, so the file has to be the real one. |
| README excerpts of neofetch and DMNO | `packages/ai/src/prompts/summarize.recorded.json` | From [dylanaraps/neofetch](https://github.com/dylanaraps/neofetch), Copyright (c) 2015-2021 Dylan Araps, and [dmno-dev/dmno](https://github.com/dmno-dev/dmno), Copyright (c) 2024 DMNO Inc., each under the MIT license. The recorded model replies answer these exact inputs. |

The MIT license text these rows refer to is under T3 Code below, with each project's own copyright line in place of T3 Code's. The other icon images and README samples in test fixtures are made up for the tests.

## T3 Code

`docs/effect.md` quotes code from T3 Code (https://github.com/pingdotgg/t3code) under its MIT license.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
