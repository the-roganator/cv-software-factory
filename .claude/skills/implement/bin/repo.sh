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
# reason the best line naming the path gives it; exits 1, printing nothing, if no line names it, and 2 for a path it
# cannot look for. Each line is read as tokens, split at spaces, at dashes, quotes and ellipses beyond ASCII, and at
# markdown's `*[]()<>"',;|, so a path in backticks, bare, or as a link's text is a token of its own (a link's target is
# left out: it names nothing and gives no reason). A token names the
# path when it is the path, less a leading / or ./ (as CODEOWNERS writes paths) and any closing .:!? (as a sentence
# ends): deploy/a.yaml.bak, deploy/a.yaml~ or other/deploy/a.yaml do not name deploy/a.yaml. The reason is the words,
# runs of letters and digits, of the line's prose: what is in backticks is code, a path or a name, and so is a token with
# both a slash and a dot (a bare path, a link's target) or a :// (a URL), while read/write is two words. A path to look for must
# be [A-Za-z0-9._/-] alone, as every one in both repositories is, so that no delimiter splits it.
owned_reason() {
  [[ $1 =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "owned_reason: $1 holds characters a section cannot be read for" >&2; return 2; }
  path=$1 LC_ALL=C awk '
    BEGIN {
      path = ENVIRON["path"]; best = -1
      # Dashes (figure, en, em, bar, minus), curly quotes, the ellipsis and a no-break space, in UTF-8.
      split("\342\200\222 \342\200\223 \342\200\224 \342\200\225 \342\210\222 \342\200\230 \342\200\231 " \
        "\342\200\234 \342\200\235 \342\200\246 \302\240", marks, " ")
    }
    {
      line = $0
      for (m in marks) gsub(marks[m], " ", line)
      # A link is its text: its target, a path or not, is neither the name nor a reason.
      gsub(/\]\([^)]*\)/, "] ", line)
      # Code spans, as markdown reads them: a run of backticks opens one and the next run as long closes it; one left
      # open is text.
      pieces = 0; rest = line; opener = ""; named = 0; words = 0
      while (match(rest, /`+/)) {
        run = substr(rest, RSTART, RLENGTH); before = substr(rest, 1, RSTART - 1); rest = substr(rest, RSTART + RLENGTH)
        if (opener == "") { piece[++pieces] = before; code[pieces] = 0; opener = run; span = "" }
        else if (run == opener) { piece[++pieces] = span before; code[pieces] = 1; opener = "" }
        else span = span before " "
      }
      piece[++pieces] = (opener == "" ? "" : span) rest; code[pieces] = 0
      for (p = 1; p <= pieces; p++) {
        text = piece[p]; gsub(/[]*()<>"\047,;|[]/, " ", text)
        n = split(text, tokens, /[ \t\r]+/)
        for (t = 1; t <= n; t++) {
          token = tokens[t]; prose = !code[p] && !(index(token, "/") && index(token, ".")) && !index(token, "://")
          sub(/^\.?\//, "", token); sub(/[.:!?]+$/, "", token)
          if (token == path) named = 1
          else if (prose) words += gsub(/[[:alnum:]\200-\377]+/, "", token)
        }
      }
      if (named && words > best) best = words
    }
    END { if (best < 0) exit 1; print best }'
}
