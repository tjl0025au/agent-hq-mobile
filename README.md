# Agent HQ (mobile)

A phone version of Agent HQ. It's an installable web app that reads your agent
company's status straight from the private `claude-agents` repo on GitHub, so it
works with your computer off.

This repo holds only the app's code. Your research data stays in `claude-agents`
and is fetched on your phone with your own read-only token, which is stored only
in that phone's browser.

## Tabs
- **Org chart**: Founder, Chief of Staff and every agent, lit up while they work
  in a research round. Tap any box for its description, tools, recent work and
  full instructions.
- **Research**: live and past rounds from `status/live.json`, each worker's
  direction, state and best find. Rounds not updated for 45 minutes show "Stalled?".
- **New ideas**: opportunities from `research/ideas-log.md` (New, latest round, or all),
  plus the directions explored so far.
- **Pipeline**: every opportunity grouped by status.
- **Settings**: token, repo, theme.

It refreshes every 30 seconds while open, and whenever you switch back to it.

## Setup
1. Create a fine-grained token at GitHub → Settings → Developer settings →
   Fine-grained tokens. Repository access: only `claude-agents`. Permissions:
   Contents → Read-only.
2. Open the app's GitHub Pages address on your phone, go to Settings, paste the token.
3. Add it to your home screen (iPhone: Safari → Share → Add to Home Screen;
   Android: Chrome → ⋮ → Install app).

## Hosting
Served by GitHub Pages from the `main` branch root. No build step: plain HTML,
CSS and JavaScript.
