# Sourced by worktree.sh, copilot.sh and verify.sh: the repository a work item's key names, where it is checked out, and
# the files a pull request in it changes.
# A key that begins app- (app-flag-context) is a work item in the app's repository, checked out at APP_DIR, by default
# beside this one; any other key is this repository's. Every worktree lives under this checkout's
# scratch/worktrees/<key>, whichever repository it belongs to. `root` is this checkout, found from where the scripts
# are rather than from the current directory, so they work from either repository's worktrees.
root=$(cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
# for_key <key>: sets key (without a leading #), wt (its worktree), checkout (its repository's main checkout) and repo
# (owner/name, for gh's -R).
for_key() {
  key=${1#\#}
  wt="$root/scratch/worktrees/$key"
  checkout=$root
  if [[ $key == app-* ]]; then
    checkout=${APP_DIR:-$root/../cv-worlds-worst-website}
    [[ -e $checkout/.git ]] || { echo "no checkout of the app at $checkout: set APP_DIR" >&2; exit 2; }
    checkout=$(cd "$checkout" && pwd)
  fi
  repo=$(repo_of "$checkout")
  if [[ $key == app-* && $repo != */cv-worlds-worst-website ]]; then
    echo "$checkout is a checkout of $repo, not the app's: set APP_DIR" >&2; exit 2
  fi
}
# own_commits <worktree>: how many commits its HEAD has that the commit its branch was made from does not. The branch's
# reflog starts there, whether that was origin/main or, in a stack, the branch below, so it counts what was added since
# even once the branch below has merged and gone; with no reflog, it counts from origin/main.
own_commits() {
  local branch base
  branch=$(git -C "$1" branch --show-current)
  base=$(git -C "$1" reflog show --format=%H "refs/heads/$branch" -- 2>/dev/null | tail -1)
  git -C "$1" rev-list --count "${base:-origin/main}..HEAD"
}
# repo_of <checkout>: owner/name of its origin on GitHub, read from git rather than asked of GitHub.
repo_of() {
  git -C "$1" remote get-url origin | sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##; s#\.git$##'
}
# pr_files <repo> <pr>: each file the pull request changes, a line each: its path, and for a file renamed or moved, a
# tab and the path it had. From the files API, a page at a time, which lists any number of files up to its 3000, so a
# caller that must see them all compares the count of lines with the pull request's changedFiles.
pr_files() {
  gh api "repos/$1/pulls/$2/files?per_page=100" --paginate -q '.[] | [.filename, .previous_filename // empty] | join("\t")'
}
# owned_reason <path>: reads a description's section on CODEOWNERS' files from stdin and prints how many words of
# reason the best line naming the path gives it; exits 1, printing nothing, if no line names it. Each line is read as
# tokens, split at spaces, at any byte beyond ASCII (an em dash, a curly quote) and at markdown's `*[]()<>"',;|, so a
# path in backticks, bare, or as a link's text is a token of its own. A token names the path when it is the path, less
# a leading / or ./ (as CODEOWNERS writes paths) and any closing .:!? (as a sentence ends): deploy/a.yaml.bak,
# deploy/a.yaml~ or other/deploy/a.yaml do not name deploy/a.yaml. The reason is what the rest of the line says: each
# run of letters and digits in a token with no slash, so no other path, link target or URL counts towards it. Paths here
# are [A-Za-z0-9._/-] alone, and none holds a delimiter.
owned_reason() {
  path=$1 LC_ALL=C awk '
    BEGIN { path = ENVIRON["path"]; best = -1 }
    {
      line = $0
      gsub(/[\200-\377]+/, " ", line); gsub(/[`*()<>"\047,;|[]/, " ", line); gsub(/]/, " ", line)
      n = split(line, tokens, /[ \t\r]+/); named = 0; words = 0
      for (t = 1; t <= n; t++) {
        token = tokens[t]
        sub(/^\.?\//, "", token); sub(/[.:!?]+$/, "", token)
        if (token == path) named = 1
        else if (index(token, "/") == 0) words += gsub(/[[:alnum:]]+/, "", token)
      }
      if (named && words > best) best = words
    }
    END { if (best < 0) exit 1; print best }'
}
