# Grok Desktop

Desktop app for [Grok Build](https://x.ai/cli) — multi-project chats, tools, RTL, same **SuperGrok / X Premium+** login as the CLI.

![Grok Desktop](docs/hero.png)

## Requirements

- macOS 12+ or Windows 10+ (or Linux)
- [Grok Build CLI](https://x.ai/cli) installed and signed in:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## Install (macOS)

1. Download the latest **`.dmg`** from [Releases](../../releases)
2. Open the DMG → drag **Grok Desktop** to Applications
3. First open: right-click → **Open** (unsigned build)

## Run from source

```bash
git clone https://github.com/soheil42/grok-desktop.git
cd grok-desktop
npm install
npm start
```

### Windows build (on a Windows machine)

```bash
npm install
npm run dist:win
```

Artifacts land in `release/`. Cross-building Windows installers from macOS is not supported by electron-builder without extra tooling.

### macOS build

```bash
npm run dist:mac
```

## Usage

| Action | How |
|--------|-----|
| Open project | **Open** in sidebar |
| New chat | **+ New chat** (won't spam empty drafts) |
| Delete chat | Hover row → **×** (removes session + subagents on disk) |
| Agent mode | **Shift+Tab** → Agent / Plan / Auto |
| Send | **⌘/Ctrl + Enter** or **↑** |

Auth uses `~/.grok/auth.json` from `grok login` (or `XAI_API_KEY`).

## License

MIT. Not an official xAI product. Grok/xAI marks belong to their owners; used only to identify the CLI this app connects to.
