import { Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { capture } from "../lib/analytics.ts";
import { avatarOf } from "../lib/avatar.ts";
import { useFollows } from "../lib/follows.ts";
import type { SimilarPerson } from "../lib/rpc.ts";
import { sameQuestionFaces, useSimilarPeople } from "../lib/same-question.ts";
import { formatCount } from "../lib/whose.ts";

// What a face says beside the handle: that you follow them, how many stars they share with you on your own page, or
// what their stars are mostly about.
const noteOf = (person: SimilarPerson, following: boolean, own: boolean) =>
  following
    ? "you follow"
    : own
      ? `${formatCount(person.shared)} in common`
      : person.topics[0] && `mostly ${person.topics[0]}`;

// Under a search's answer, the people with stars like this page's person, each a link that asks them the same words.
// Nothing shows until the people arrive, and nothing at all for a login nobody is like.
export function SameQuestion({
  login,
  query,
  own,
  signedIn,
}: {
  login: string;
  query: string;
  own: boolean;
  signedIn: boolean;
}) {
  const people = useSimilarPeople(login);
  const follows = useFollows(signedIn);
  if (people === undefined || people.length === 0) return null;
  const faces = sameQuestionFaces(people, follows.isFollowing, 4, 2);
  return (
    <Tile
      variant="quiet"
      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-2.5 sm:px-6 sm:py-[18px]"
    >
      <h2 className="shrink-0 font-sans text-meta text-muted-foreground sm:pr-1.5 sm:leading-9">same question in</h2>
      <ul className="flex min-w-0 flex-1 gap-2 max-sm:-mx-5 max-sm:overflow-x-auto max-sm:px-5 max-sm:[mask-image:linear-gradient(to_left,transparent,#000_16px)] max-sm:[scrollbar-width:none] sm:flex-wrap sm:gap-2.5">
        {faces.map((person, index) => {
          const note = noteOf(person, follows.isFollowing(person.login), own);
          return (
            <li key={person.login} className="shrink-0">
              <Link
                to="/@{$login}"
                params={{ login: person.login }}
                search={{ q: query }}
                onClick={() => capture("same_question_opened", { position: index + 1 })}
                className="flex h-9 items-center gap-2 rounded-full bg-card py-1 pr-3.5 pl-1 font-sans text-meta transition-colors duration-120 hover:bg-muted"
              >
                <img
                  src={avatarOf(person.login, 28)}
                  alt=""
                  width={28}
                  height={28}
                  loading="lazy"
                  className="size-7 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
                />
                <span className="font-semibold">{`@${person.login}`}</span>
                {note && <span className="text-muted-foreground max-sm:hidden">{note}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </Tile>
  );
}
