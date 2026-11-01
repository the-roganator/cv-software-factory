---
name: visual-pr
description: Write a pull request's description from its branch, in a context of its own, and return the file it wrote. Use before opening a pull request in this repository or the app's, and again when review changes the shape of the change.
argument-hint: "<base ref> <note file>"
context: fork
agent: general-purpose
background: false
---

# Describe a pull request, in a fresh context

You run in a context of your own. You have not seen the session that made this change: the code tells you what changed, and the note tells you why. Arguments: `$ARGUMENTS`, which are, in order:

1. **The base**: the branch the pull request merges into, `origin/main` or, in a stack, the pull request below it.
2. **The note**: a short file from whoever made the change. It says why the change exists, the decisions it took and the ones it turned down, what it left out and where that went, and how it was tested. Its first lines name the checkout the branch is in, when that is not this repository (a pull request to the app), and the plan's task, when there is one: read that task in `docs/PLAN/`.

## Steps

1. Read `apps/runner/plugin/skills/visual-pr/SKILL.md` and follow it. It is the factory's describer, vendored with its licence, and this skill runs it for people's pull requests without changing it, so the line's cassettes stay valid. Where it differs:
   - What "the step gives you" is the note and the plan's task.
   - `base` is the base above, in the note's checkout: the diff is `git diff <base>...HEAD`, the commits `git log <base>..HEAD`, and the template `git show <base>:.github/pull_request_template.md`.
   - Its `references/show-me.md` is beside it, in `apps/runner/plugin/skills/visual-pr/references/`.
   - The repository's recent descriptions, which name its folded sections, are its merged pull requests': `gh pr list -R <owner>/<repo> --state merged --author mrogan --limit 20 --json body -q '.[].body' | grep '^## ' | sort | uniq -c | sort -rn` counts their headings, where `<owner>/<repo>` is the note's checkout's (`gh repo view --json nameWithOwner -q .nameWithOwner`, run there). Take the most used of any that mean the same.
   - Where it says a description whose folded sections would not render is refused, step 4 is the check.
   - Write the description to this repository's `scratch/pr/<owner>-<repo>/<branch>.md`, in the main checkout (`$(git rev-parse --path-format=absolute --git-common-dir)/..`, run in this checkout, not the note's) even when you run in a worktree of it. `<owner>/<repo>` is the note's checkout's, as above, so a branch of the same name in the other repository has a file of its own; any `/` in the branch's name is made `-`. `scratch/` is ignored by git.
2. When the diff changes images the repository keeps (the console's visual snapshots in `apps/console/e2e/snapshots/`, or any other committed `.png`), show the change: a reviewer should see it before reading about it.
   - List them with `git diff --name-status --find-renames --diff-filter=AMR <base>...HEAD -- '*.png'`: `A` is new, `M` changed, and `R` renamed, with its old path then its new one. Look at the versions each candidate has (`git show <fork>:<old path>`, for `M` and `R` only, where `<fork>` is `git merge-base <base> HEAD`, the commit the diff starts from, and `git show HEAD:<path>`, saved to your scratchpad, then read) and choose the few that show the change best: up to four, at one width unless widths behave differently, in the light theme unless the change is to the dark theme itself; one is enough when it is all there is. Say in a line how many others changed and that they change the same way, or what else they show.
   - Show a changed or renamed one as one picture: `node .claude/skills/visual-pr/bin/show.ts <before.png> <after.png> <svg>` writes it, each picture under a band that says which it is, and prints which it chose and, for a two-up, whether it outlined anything. A change in a few small places blinks between Before and After, so the change is what moves. One over much of the picture, such as a list reordered, is too much to follow in a blink: it shows two-up, Before beside or above After, with what moved or changed outlined on each (none when that would be most of it). Write each SVG to this repository's `scratch/pr/<owner>-<repo>/<branch>/`, named as for the description, beside it, named after its snapshot, and nothing else there: the PNGs stay in your scratchpad. Reference it by its absolute path: the caller attaches it, and `gh` uploads it and rewrites the path to where GitHub keeps it. A renamed one's Before is at its old path. A snapshot that is new has no Before: show it alone, linked by its commit, as GitHub serves a file: `https://github.com/<owner>/<repo>/blob/<head sha>/<path>?raw=true`.
   - Wrap each in a link to the snapshot's own diff, `[![<alt>](<svg>)](https://github.com/<owner>/<repo>/compare/<fork>...<head sha>#diff-<sha256 of the path>)`, where GitHub shows the two side by side, as a swipe and as an onion skin. Opened alone the SVG shows its bands and no pictures, because GitHub serves it under a policy that blocks the pictures inside it, so the link is what a click needs. `<owner>/<repo>` is the note's checkout (`gh repo view --json nameWithOwner -q .nameWithOwner`), `<head sha>` is `git rev-parse HEAD`, and the path's hash is `printf %s <path> | shasum -a 256`. Commits' links keep working after a squash merge, because the pull request keeps its commits, and `<fork>` is on GitHub because the base is.
   - Put them under the description's opening, before the prose that explains them, one under the other, each with a caption naming what the reviewer should look at. Give each alt text that says what it shows and what changes between the two; a two-up's caption says what the outlines mark, when it has them.
3. When the note names screenshots taken for this pull request that the repository does not keep, such as design views, show them too. Whoever made the change takes them before calling you, and the note gives each one's absolute path and what it shows. They keep to one rule:
   - The light theme only, at a desktop width and a phone width. A change to the dark theme itself is the exception: it shows dark.
   - No filled backdrop behind a group of pictures: they sit on the page's own colour, light or dark as each reader sets GitHub.
   - A thin border, drawn on the picture, where its edge must read against the page, such as a white page on GitHub's light theme.

   Look at each one, and leave out any that breaks the rule: your answer names it and says why, so the caller can take it again. Reference the rest by their absolute paths, as the SVGs are, under the description's opening and after any snapshots, each with a caption and alt text as in step 2. They link to nothing: no diff holds them.
4. Check it renders: `node .claude/skills/visual-pr/bin/check.ts <file>` checks its folded sections by the describer's own rule, then renders it with GitHub's own renderer, which publishes nothing, and names each section that broke and any Markdown left as text, and a summary that is not one heading. Fix what it names until it exits 0. It renders in the context of the repository it runs in, so when the note names another checkout, run it there, by this checkout's absolute path to it.
5. Answer with the file's path and one line on the description's shape. When it has pictures, list the SVGs and screenshots by their absolute paths, and say that each shows only once attached, that the snapshots' links work only once `HEAD` is pushed, and that a later push leaves the pictures as they are: run this skill again when review changes what they show. Do not repeat the description: keeping it out of the caller's context is why this skill runs on its own.

Do not commit, push, or open or edit a pull request. Whoever called you writes the title, and adds the attribution lines as a collapsed section of their own at the very end, the first line as a small heading in the summary and the rest as its body:

```markdown
<details>
<summary>

###### 🤖 Generated with [Claude Code](https://claude.com/claude-code)

</summary>

<the rest of the attribution, such as the session's link>

</details>
```

Then they open the pull request with `gh pr create --body-file`, or update it with `gh pr edit --body-file`. Either way, with pictures, they pass `--attach <path>` for each SVG and screenshot you list, spelled as you list it. Then `node .claude/skills/visual-pr/bin/check.ts --pr <pr>` checks the published body: what it renders, and that no local path is left, which would be a broken picture that shows the world where this checkout lives. It reads the pull request from the repository it runs in, so for one in the app's repository they run it in the app's worktree, by this checkout's absolute path to it.
