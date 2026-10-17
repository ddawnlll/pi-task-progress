# pi-task-progress

A Pi extension that displays task progress in the TUI and lets you accept a suggested follow-up prompt with **Tab**.

## Features

- Reads `İlerleme: n/m (%p) — ...` from the assistant's latest response and shows a progress bar in the status area.
- Shows a `Sonraki adım promptu: ...` suggestion below the editor (or inline as ghost text) and inserts it into an empty editor when you press **Tab**.
- Restores the latest progress and suggestion when navigating or resuming a session.
- Adds task-progress guidance to the system prompt when equivalent guidance is not already present.
- Keeps terminal-specific behavior in TUI mode and preserves another extension's custom editor.

## Requirements

- Pi 1.2.0 or later (uses the Pi extension and TUI APIs).

## Install from a local checkout

```bash
pi install ~/src/pi-task-progress
```

Or load it for one invocation while developing:

```bash
pi --extension ~/src/pi-task-progress/extensions/task-progress.ts
```

After installing, restart Pi or run `/reload`.

## Install from GitHub

Once this repository has been pushed to GitHub, install it with:

```bash
pi install git:github.com/OWNER/pi-task-progress
```

Replace `OWNER` with the GitHub account or organization that owns the repository.

## Progress and follow-up formats

The extension recognizes one-line markers such as:

```text
İlerleme: 2/4 (%50) — testler tamamlandı; sıradaki: edge case'leri doğrula
Sonraki adım promptu: Başarısız testleri düzelt ve yeniden çalıştır.
```

A follow-up suggestion can be accepted with **Tab** while the editor is empty.
