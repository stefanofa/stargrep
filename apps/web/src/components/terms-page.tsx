import { stargrepRepoUrl } from "../lib/github-star.ts";
import { ExternalTextLink } from "./external-text-link.tsx";
import { Section, TextPage } from "./text-page.tsx";

export function TermsPage() {
  return (
    <TextPage heading="terms">
      <p className="font-sans text-lg text-secondary-foreground">
        the rules for using stargrep.com. by using the site, the API, or the MCP server, you accept them. last changed
        November 18, 2026.
      </p>
      <Section heading="as is">
        <p>
          stargrep is provided as is and as available, with no warranty of any kind, express or implied, including
          fitness for a purpose, accuracy, or uptime. it may change, lose data, or stop at any time, with or without
          notice.
        </p>
      </Section>
      <Section heading="liability">
        <p>
          to the fullest extent the law allows, stargrep's maker and contributors are not liable for any damages or
          losses that come from using it or not being able to use it, whether direct, indirect, incidental, or
          consequential.
        </p>
      </Section>
      <Section heading="results">
        <p>
          search results, summaries, and descriptions are made automatically, some by AI, from public GitHub data. they
          can be wrong or out of date, so check a repo before you rely on it. each repo belongs to its owner, and
          stargrep is not affiliated with or endorsed by GitHub.
        </p>
      </Section>
      <Section heading="fair use">
        <p>
          don't abuse the service, scrape it beyond the public API's rate limits, or try to break, overload, or get
          around its limits. stargrep may block any account or network, at any time, for any reason.
        </p>
      </Section>
      <Section heading="source code">
        <p>
          the <ExternalTextLink href={stargrepRepoUrl}>source code</ExternalTextLink> is licensed under AGPL-3.0. that
          license covers the code. these terms cover the hosted service.
        </p>
      </Section>
      <Section heading="changes">
        <p>these terms may change. using stargrep after a change means you accept the new terms.</p>
      </Section>
      <Section heading="contact">
        <p>
          questions go to <ExternalTextLink href="https://x.com/stefanofa">@stefanofa</ExternalTextLink>.
        </p>
      </Section>
    </TextPage>
  );
}
