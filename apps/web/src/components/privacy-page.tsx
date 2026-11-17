import { stargrepRepoUrl } from "../lib/github-star.ts";
import { ExternalTextLink } from "./external-text-link.tsx";
import { Bullets, Code, Section, TextPage } from "./text-page.tsx";

export function PrivacyPage() {
  return (
    <TextPage heading="privacy">
      <p className="font-sans text-lg text-secondary-foreground">
        what stargrep keeps, and why. stargrep is open source, so you can check every line here against{" "}
        <ExternalTextLink href={stargrepRepoUrl}>the code</ExternalTextLink>. last changed November 17, 2026.
      </p>
      <Section heading="what stargrep stores">
        <Bullets>
          <li>
            public GitHub data for every account someone opens on stargrep, signed in or not: its login, name, avatar,
            follower and repo counts, and the repos it starred, with when.
          </li>
          <li>
            public data about those repos: name, description, topics, README, star counts, and a summary and an
            embedding that stargrep makes from them. each repo is stored once, however many accounts starred it.
          </li>
          <li>
            if you sign in with GitHub: your GitHub user ID, name, email address, and avatar, your GitHub token,
            encrypted, and the IP address and browser of each session. beyond public data, stargrep's GitHub app asks
            only to read your email addresses. your token is used only for work you start, such as syncing your own
            stars.
          </li>
          <li>rate limit counters for each network, under a keyed hash of its address, never the address itself.</li>
        </Bullets>
      </Section>
      <Section heading="searches">
        <p>
          stargrep sends your search to a model provider, which reads it and turns it into an embedding. so a repeat
          search is fast, stargrep keeps the query text, that reading, and the embedding for 30 days, with nothing about
          who searched. answers to searches of the demo account are also cached for about a day.
        </p>
        <p>
          search sends the query in a request body, not the URL. a shared link with <Code>?q=</Code> does put it in the
          URL, and Cloudflare's request logs record full URLs.
        </p>
      </Section>
      <Section heading="ai processing">
        <p>
          model providers summarize and embed READMEs and repo details, and plan and embed searches, through Vercel AI
          Gateway. no email address or token goes to a model.
        </p>
      </Section>
      <Section heading="analytics">
        <p>stargrep.com uses PostHog, on its US cloud, to count visits and catch errors. other hosts send nothing.</p>
        <Bullets>
          <li>
            in your browser, PostHog runs cookieless: no cookie and nothing in storage. it records page views and
            leaves, errors, and clicks on the header's GitHub star link. every URL loses its query string and fragment
            first, so searches, filters, and the open repo never leave. there is no autocapture, session recording, or
            survey. events go through PostHog's proxy at <Code>tortilla.stargrep.com</Code>.
          </li>
          <li>
            on the server, stargrep sends counts: imports, searches, sign-ups, model calls, and errors. a search event
            holds how it was answered, the number of results, and the time it took, never the query.
          </li>
          <li>
            a signed-out visitor shows up in PostHog as a hash of their network's keyed hash, which matches nothing
            stargrep stores. a signed-in user shows up as their stargrep user ID, and only users get a PostHog profile.
          </li>
        </Bullets>
      </Section>
      <Section heading="cookies">
        <Bullets>
          <li>signing in sets Better Auth's session cookies.</li>
          <li>
            <Code>stargrep-view</Code> remembers tiles or list for a year.
          </li>
          <li>
            <Code>stargrep-refused</Code> remembers a refused import for up to ten minutes, so a reload says so again.
          </li>
          <li>the home page's typing intro sets one flag in session storage, so it plays once per tab.</li>
        </Bullets>
        <p>no tracking or ad cookies.</p>
      </Section>
      <Section heading="who runs what">
        <p>
          Cloudflare runs the site, Neon hosts the database in AWS us-east-1, Vercel AI Gateway routes model calls,
          PostHog takes analytics, and GitHub supplies the data and the sign-in.
        </p>
      </Section>
      <Section heading="removal">
        <p>
          to have your account or an account's stars removed, open an issue on{" "}
          <ExternalTextLink href={`${stargrepRepoUrl}/issues`}>github.com/stefanofa/stargrep</ExternalTextLink>, which
          is public, or message <ExternalTextLink href="https://x.com/stefanofa">@stefanofa</ExternalTextLink> on X.
        </p>
      </Section>
    </TextPage>
  );
}
