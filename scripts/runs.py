"""List the unfinished Agent Context work, one row per target.

Reads every run record under ``<root>/logs/**/runs/*.json``, keeps the latest
run of each target (repository plus pull request, Jira key or branch) started
in the last ``--days`` days, and prints those that are not repository-complete
as one JSON array on stdout. Read-only.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_time(text: object) -> datetime | None:
    if not isinstance(text, str) or text == "":
        return None
    try:
        when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--days", type=int, default=30)
    args = parser.parse_args()

    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    latest: dict[tuple[str, str], tuple[datetime, dict]] = {}
    cutoff = since.timestamp()
    for path in Path(args.root, "logs").glob("**/runs/*.json"):
        try:
            # A record last written before the window cannot hold a run started in it.
            if path.stat().st_mtime < cutoff:
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        started = parse_time(record.get("startedAt"))
        if started is None or started < since:
            continue
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        repo = target.get("repository")
        anchor = target.get("pullRequest") or target.get("jiraKey") or target.get("branch")
        key = (str(repo or "").lower(), str(anchor or record.get("runId") or path.stem))
        if key not in latest or started > latest[key][0]:
            latest[key] = (started, record)

    rows = []
    for started, record in sorted(latest.values(), key=lambda item: item[0], reverse=True):
        status = record.get("repositoryStatus")
        if status == "repository-complete" and record.get("completedAt"):
            continue
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        session = record.get("session") if isinstance(record.get("session"), dict) else {}
        pr = target.get("pullRequest")
        rows.append(
            {
                "runId": str(record.get("runId") or ""),
                "repo": target.get("repository"),
                "pr": pr if isinstance(pr, int) else None,
                "jiraKey": target.get("jiraKey"),
                "branch": target.get("branch"),
                "workflow": str(record.get("workflow") or "?"),
                "status": str(status or ("en cours" if not record.get("completedAt") else "?")),
                "startedAt": started.isoformat(),
                "client": session.get("client") or record.get("runtimeProfile"),
                "sessionId": session.get("id"),
            }
        )
    json.dump(rows, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
