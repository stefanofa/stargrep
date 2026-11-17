import { Link } from "@tanstack/react-router";
import { stargrepRepoUrl } from "../lib/github-star.ts";
import { mcpTools, mcpUrl } from "../lib/mcp.ts";
import { ExternalTextLink, textLinkClass } from "./external-text-link.tsx";
import { Bullets, Code, CodeBlock, Section, TextPage } from "./text-page.tsx";

const searchCall = `curl -X POST https://stargrep.com/api/search \\
  -H 'content-type: application/json' \\
  -d '{"q": "rust library for terminal dashboards",
       "scope": {"kind": "stars", "login": "stefanofa"}}'`;

export function DevelopersPage() {
  return (
    <TextPage heading="use stargrep from your agent">
      <p className="font-sans text-lg text-secondary-foreground">
        ask your coding agent for the library you starred two years ago. stargrep serves search over MCP and REST, with
        no key and no sign-in.
      </p>
      <Section id="mcp" heading="mcp">
        <p>
          the server speaks streamable HTTP at <Code>{mcpUrl}</Code>.
        </p>
        <CodeBlock label="Claude Code">{`claude mcp add --transport http stargrep ${mcpUrl}`}</CodeBlock>
        <CodeBlock label="Codex, in ~/.codex/config.toml">{`[mcp_servers.stargrep]\nurl = "${mcpUrl}"`}</CodeBlock>
        <CodeBlock label="Cursor, in ~/.cursor/mcp.json">
          {`{\n  "mcpServers": {\n    "stargrep": { "url": "${mcpUrl}" }\n  }\n}`}
        </CodeBlock>
        <p>it serves these tools. all of them only read, except that triggerSync queues an import.</p>
        <Bullets>
          {mcpTools.map((tool) => (
            <li key={tool.name}>
              <Code>{tool.name}</Code> {tool.does}
            </li>
          ))}
        </Bullets>
        <p>
          a login stargrep hasn't seen needs <Code>triggerSync</Code> first. search answers once its stars are synced.
        </p>
      </Section>
      <Section id="api" heading="api">
        <p>
          the same procedures answer over REST under <Code>/api</Code>, and{" "}
          <a href="/openapi.json" className={textLinkClass}>
            /openapi.json
          </a>{" "}
          describes them.
        </p>
        <CodeBlock label="search someone's stars">{searchCall}</CodeBlock>
        <p>
          both read public stars only. requests are rate limited per network, and a <Code>429</Code> means slow down.
        </p>
      </Section>
      <Section heading="the code">
        <p>
          stargrep is open source, and the API lives in{" "}
          <ExternalTextLink href={`${stargrepRepoUrl}/tree/main/packages/api`}>packages/api</ExternalTextLink>. the{" "}
          <Link to="/privacy" className={textLinkClass}>
            privacy page
          </Link>{" "}
          says what stargrep keeps.
        </p>
      </Section>
    </TextPage>
  );
}
