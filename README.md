# PR Radar

PR Radar is a Claude Code mod. It adds a pane that lists every open GitHub pull request tied to your account and sorts them into lanes by who must act next. Each card shows the review state, CI, open review threads, the Jira status and priority, the linked Claude sessions, and unfinished Agent Context runs. Its buttons start the next step.

It runs in Claude Code: the terminal CLI, the Code tab of the desktop app, and the VS Code extension. It does not run in claude.ai chat or Cowork, and `claude -p` or cloud sessions draw no pane.

## Install

```text
/plugin marketplace add WBLD4A/pr-radar
/plugin install pr-radar@pr-radar
```

Or from a shell:

```bash
claude plugin marketplace add WBLD4A/pr-radar
claude plugin install pr-radar@pr-radar
```

Then run `/reload-plugins` in open sessions.

## Use

The pane opens on its own at the start of every session, without taking focus. `/prs` reopens it, and `/prs refresh` refreshes it right away. While the pane is closed, a button above the prompt reopens it. The model reads the same data through the mod's `snapshot` tool, so you can ask it things like "what should I do next?", and marks pull requests in progress through its `mark` tool.

The pane has seven lanes, in this order:

1. **Blocked**
2. **Your turn**
3. **In progress**
4. **Ready for manual review**
5. **Waiting on others**
6. **Drafts**
7. **On hold**

Inside a lane, cards are sorted by Jira priority, then by most recent update. A Jira status that means blocked or on hold moves the pull request to that lane. Below the lanes, the pane lists the Jira issues assigned to you that are in progress but have no pull request yet.

What a card's buttons do:

- start the pull request's next step in a new conversation;
- mark the pull request as in progress;
- continue unfinished work;
- copy the pull request's URL.

On your own pull requests, **Mark ready** marks a draft ready for review, and **Back to draft** turns a pull request in the Ready for manual review lane back into a draft. Both run `gh pr ready`. A mark lasts until the pull request next changes on GitHub.

An agent can set the same mark without the button through the mod's `mark` tool, `mcp__pr-radar__mark`. It takes `prs`, a list of `owner/repo#123` references or pull request URLs, and `inProgress`, `true` to mark them or `false` to remove the mark. It answers each pull request's new lane, or why that pull request is not in the radar. The mark lives in the radar only: it changes nothing in Jira or on GitHub, and a pull request on hold stays on hold.

A new conversation opens as a desktop session when the app offers one. Otherwise it opens in a new Terminal tab with a PowerShell command, a fallback that works only on Windows. If neither is possible, the prompt goes into the composer.

## Requirements

- **Required:** the [`gh` CLI](https://cli.github.com/), signed in. PR Radar lists your pull requests through `gh api graphql`, which costs a few points of your account's hourly GraphQL budget per refresh.
  - When the budget runs low, automatic refreshes wait for it to reset.
  - When the budget is spent, every refresh waits.
  - Meanwhile the pane keeps the last pull requests it got and says when it will ask again.
- **Required:** `python` on `PATH`. The scripts in [`scripts/`](scripts/) find your local checkouts and read run records.
- **Optional:** an Atlassian (Jira) connector in the session. It adds the Jira status and priority, and lists the issues you have in progress. Without it, cards leave Jira out. An automatic refresh skips any connector call that would ask for a permission, so no dialog opens on its own; `/prs refresh` does ask.
- **Optional:** the desktop app's session tools. They link cards to the Claude sessions working on them. Without them, cards leave sessions out.
- **Optional:** an Agent Context checkout, a private workflow repository whose run records (`logs/**/runs/*.json`) note unfinished agent work. PR Radar reads them to list that work. Without one, that section stays empty.

## What it does on your machine

A mod runs with your own permissions and is not sandboxed. PR Radar is read-only except for the buttons you press. Everything it does is listed here.

Processes it starts:
- `gh api graphql`, `gh api user` and `gh api rate_limit`, to list your pull requests and read your GraphQL budget;
- `gh pr ready` (with `--undo` for Back to draft), only when you press **Mark ready** or **Back to draft**;
- `git -C <folder> remote get-url origin`, to match the Claude sessions to their repositories;
- `python -I scripts/runs.py` and `python -I scripts/checkouts.py`, the two read-only scripts in this repository;
- a PowerShell command in a new Terminal tab, only when you start a conversation and the desktop app offers no session tool.

Files it reads:
- the run records under `<agentContextPath>/logs/**/runs/*.json`;
- the `.git/config` of the folders one level below your home folder and its `Documents`, `Documents/GitHub`, `source/repos` and `repos` folders, to find each repository's local checkout.

Network calls: only GitHub through `gh`, and Jira through the Atlassian connector of your session when you have one. It sends no data anywhere else, and stores its snapshot, marks and lease in the plugin's own store.

Tools of the session it calls: the Atlassian connector's JQL search and site list, and the desktop app's session list, start-session, send-message and Terminal tools. A call that would ask for a permission runs only when you refresh with `/prs refresh` or press **Authorize**.

### Notes for the directory review

- **Tools the mod calls itself** (`callTool` in `hooks/register.tsx`): only the session tools named above, found by these fixed name suffixes: `__searchJiraIssuesUsingJql`, `__getAccessibleAtlassianResources`, `ccd_session_mgmt__list_sessions`, `__start_session`, `ccd_session_mgmt__send_message` and `terminal__run_in_terminal`. The Jira and session-list calls run on each refresh. The other three run only when you press a card's button to start or continue a conversation. The `mark` tool calls none of them; it refreshes the radar only when the session has no snapshot yet. The tool name comes from the session's tool list, which is why it is not written as fixed text; no server answer ever picks a tool or a command.
- **The `gh api graphql` command** (`graphql` in `hooks/register.tsx`): the program and its flags are fixed text. The query is a constant built in `hooks/model.ts`, and its `$q1`…`$q4` variables are GitHub search strings made from your login (`author:<login>`, `review-requested:<login>`, and so on); the detail query takes only the pull request ids the first one returned. Only GitHub's answer is read; it is parsed as data and never run.
- **Environment variables read**: `USERPROFILE` or `HOME`, to find your home folder, and `CLAUDE_CODE_EXECPATH`, to start `claude` in the Terminal fallback. The mod reads no token or key: `gh` uses its own sign-in, and nothing read from the environment is sent anywhere.
- **Conversation data**: the mod's only `tool.call` hooks are on its own `mcp__pr-radar__snapshot` and `mcp__pr-radar__mark` tools. It answers them in place of a server, as a mod-registered tool does: `snapshot` with the radar's summary, `mark` by setting or removing the radar's own in-progress marks in the plugin's store. It does not see or change any other tool call, and sends no conversation text out.
- **The `command.run` hook** handles only the mod's own `/prs` command: it opens the pane, and with `refresh` refreshes it.

## Options

Set these in the plugin's config menu. Each option is one row there.

| Option | Default | Effect |
| --- | --- | --- |
| `agentContextPath` | empty, meaning `~/agent-context` | The Agent Context checkout whose run records are read. |
| `refreshMinutes` | `5` | The minutes between two automatic refreshes. Open sessions share one snapshot. |

## Turn it off and on

```bash
claude plugin disable pr-radar@pr-radar
```

```bash
claude plugin enable pr-radar@pr-radar
```

Then run `/reload-plugins` in open sessions.

## Development

The mod's entry point is [`hooks/register.tsx`](hooks/register.tsx), and its pure logic lives in [`hooks/model.ts`](hooks/model.ts). Run the tests and the manifest check with:

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

To publish a release, raise `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) and push it to `main`. The [release workflow](.github/workflows/release.yml) runs both checks, then creates the `v<version>` tag and its GitHub Release; a version with a `-` suffix is a prerelease. Running the workflow by hand publishes the current version when its tag does not exist yet.

## Privacy

See the [privacy policy](PRIVACY.md).

## License

[MIT](LICENSE)
