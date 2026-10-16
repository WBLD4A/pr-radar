"""Maps each GitHub repository to its main local checkout.

Looks one level below the usual roots for folders whose `.git` is a directory
(a main checkout, not a worktree) and reads the `origin` URL from its config.
Prints a JSON object: {"owner/name" (lower case): "absolute folder"}.
"""

import argparse
import configparser
import json
import os
import re

REMOTE = re.compile(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", re.IGNORECASE)


def origin_of(folder):
    parser = configparser.RawConfigParser(strict=False)
    try:
        parser.read(os.path.join(folder, ".git", "config"), encoding="utf-8")
    except (configparser.Error, OSError, UnicodeDecodeError):
        return None
    section = 'remote "origin"'
    if not parser.has_option(section, "url"):
        return None
    match = REMOTE.search(parser.get(section, "url").strip())
    return f"{match.group(1)}/{match.group(2)}".lower() if match else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", default=[])
    args = parser.parse_args()
    found = {}
    for root in args.root:
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for name in names:
            folder = os.path.join(root, name)
            if not os.path.isdir(os.path.join(folder, ".git")):
                continue
            repo = origin_of(folder)
            if repo is not None and repo not in found:
                found[repo] = os.path.normpath(folder)
    print(json.dumps(found))


if __name__ == "__main__":
    main()
