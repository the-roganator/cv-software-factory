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
# names_path <path>: the first line of stdin that names the path whole, or nothing. A path is whole where the character
# before it and the one after it cannot be part of a path (a letter, a digit, `.`, `_`, `-` or `/`), so backticks,
# a bare path and a markdown link's text all count, and deploy/a.yaml.bak or other/deploy/a.yaml do not name
# deploy/a.yaml. A `.` after it still ends it when nothing of a path follows, as at the end of a sentence.
names_path() {
  path=$1 awk '
    function pathchar(c) { return c != "" && c ~ /[[:alnum:]._\/-]/ }
    {
      path = ENVIRON["path"]; from = 1
      while ((i = index(substr($0, from), path)) > 0) {
        at = from + i - 1; end = at + length(path)
        before = at > 1 ? substr($0, at - 1, 1) : ""
        after = substr($0, end, 1)
        if (!pathchar(before) && (!pathchar(after) || (after == "." && !pathchar(substr($0, end + 1, 1))))) {
          print; exit
        }
        from = at + 1
      }
    }'
}
