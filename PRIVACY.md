# PR Radar privacy policy

PR Radar is a Claude Code mod that runs only on your machine. Its author runs no server and receives no data from it.

## What it reads

- From GitHub, through your signed-in `gh` CLI: your login and your open pull requests with their titles, branches, authors, reviewers, review threads and CI state.
- From Jira, through the Atlassian connector of your Claude session when you have one: the key, summary, status, priority, assignee and type of the issues linked to those pull requests, and of the issues assigned to you that are in progress.
- From your Claude Code session: the list of your Claude sessions, to link them to pull requests.
- From your disk: the Agent Context run records under the folder you configure, and the `.git/config` of your local checkouts.

## Where it sends data

Only to GitHub, through `gh`, and to Jira, through your own connector. It sends the GitHub search and the pull request ids it needs, and the `gh pr ready` command when you press **Mark ready** or **Back to draft**. It sends nothing to its author or to any other service.

## What it stores

The last snapshot, your marks and a refresh lease, in the plugin's own local store on your machine. Removing the plugin removes them. Nothing is stored elsewhere.

## Contact

Open an issue at https://github.com/WBLD4A/pr-radar/issues.
