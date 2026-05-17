---
name: Bug Report
about: Report a bug or unexpected behavior in the GuildMastery Sync app
title: '[Bug] '
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Open GuildMastery Sync
2. Click on '...'
3. Do '...' in-game
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, drop a screenshot of the app (especially the status banner and the bottom log panel).

**Sync logs**
The bottom **Logs de synchronisation** panel is the most useful thing for diagnosing sync issues. Click in the panel, select-all, copy, and paste here:

```
[hh:mm:ss] ...
```

**Environment**
- App version: <!-- shown in the installer / .exe name, e.g. 1.0.0 -->
- Windows version: <!-- e.g. Windows 11 Pro 24H2 -->
- RCLootCouncil_GuildMastery addon version: <!-- e.g. 1.0.0 -->
- WoW client: <!-- Retail / Classic, version, build -->
- API URL configured: <!-- usually https://guildmastery.io -->

**SavedVariables (optional)**
If the bug is related to a specific export, attach (or paste a redacted excerpt of):
```
World of Warcraft/_retail_/WTF/Account/<ACCOUNT>/SavedVariables/RCLootCouncil_GuildMastery.lua
```

> ⚠️ Never paste your **API key** in an issue. Logs in the app never contain it, but redact your `%APPDATA%\guildmasterysync\config.json` before sharing.

**Additional context**
Anything else relevant (firewall, antivirus, VPN, multi-account setup, …).
