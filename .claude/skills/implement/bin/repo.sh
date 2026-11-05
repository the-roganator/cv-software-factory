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
# reason the best line naming the path whole gives it; fails, printing nothing, if no line names it. A path is whole where
# the character before it and the one after it cannot be part of a path (a letter, a digit, `.`, `_`, `-` or `/`), so
# backticks, a bare path and a markdown link's text all count, and deploy/a.yaml.bak or other/deploy/a.yaml do not name
# deploy/a.yaml. A leading `/` or `./`, as CODEOWNERS writes paths, is part of the name, and a `.` after it still ends
# it when nothing of a path follows, as at the end of a sentence. The reason is what the line says beside the path: its
# words, a word a run of letters and digits, once the path, links' targets and URLs are taken out. Bytes, not
# characters (LC_ALL=C), so any text beside a path reads, and only ASCII is a path's.
owned_reason() {
  path=$1 LC_ALL=C awk '
    function pathchar(c) { return c != "" && c ~ /[[:alnum:]._\/-]/ }
    function char(n) { return n >= 1 ? substr($0, n, 1) : "" }
    BEGIN { path = ENVIRON["path"]; best = -1 }
    {
      rest = ""; from = 1; named = 0
      while ((i = index(substr($0, from), path)) > 0) {
        at = from + i - 1; end = at + length(path); start = at
        if (char(start - 1) == "/") start--
        if (start < at && char(start - 1) == "." && !pathchar(char(start - 2))) start--
        after = char(end)
        if (!pathchar(char(start - 1)) && (!pathchar(after) || (after == "." && !pathchar(char(end + 1))))) {
          rest = rest substr($0, from, start - from); named = 1; from = end
        } else {
          rest = rest substr($0, from, i); from = at + 1
        }
      }
      if (!named) next
      rest = rest substr($0, from)
      gsub(/\]\([^)]*\)/, "]", rest); gsub(/[a-z]+:\/\/[^ \t]*/, "", rest); gsub(/[`*]/, "", rest)
      words = gsub(/[[:alnum:]]+/, "", rest)
      if (words > best) best = words
    }
    END { if (best < 0) exit 1; print best }'
}
