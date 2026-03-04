# Code Review: GitHub Copilot

This agent delegates code review to **GitHub Copilot** rather than running a custom LLM review.

## How it works

After the SDLC agent opens a PR, Copilot automatically reviews it — no API call needed.

### Setup (one-time, per repo)

1. Go to **repo → Settings → Rules → Rulesets**
2. Create a new branch ruleset targeting your default branch
3. Under "Branch rules", enable **"Automatically request Copilot code review"**
4. Optionally enable **"Review new pushes"** so Copilot re-reviews after force-pushes

### Why not API?

GitHub does not expose an API to programmatically request Copilot as a reviewer
([community discussion](https://github.com/orgs/community/discussions/157751)).
The ruleset-based auto-review is the officially supported path.

### Requirements

- GitHub Copilot Business or Enterprise on the organization, **or** Copilot Pro/Pro+ on the user account
- Copilot code review enabled in Copilot settings

## Future

When GitHub ships an API for requesting Copilot reviews, we can add a
`requestCopilotReview()` call in `src/github/api.ts` after `openPR()`.
