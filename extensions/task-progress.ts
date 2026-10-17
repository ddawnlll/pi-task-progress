import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  type EditorTheme,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

const STATUS_KEY = "task-progress";
const NEXT_STEP_WIDGET_KEY = "task-next-step";
const PROGRESS_PROMPT_SECTION = `For substantial multi-step tasks, define a short set of outcome-based milestones and track them consistently. Before lengthy work starts, give a brief kickoff with the milestone count and 0/N progress. During long work, give a concise user-visible update when a milestone is completed or before a lengthy phase; do not narrate every tool call. At the bottom of every progress update and final response, include one concise line in this exact shape: “İlerleme: 2/5 (%40) — doğrulama sürüyor; sıradaki: raporu gözden geçir”. Keep it machine-readable on one physical line. Count a milestone complete only when its outcome is verified; do not count tool calls or partial work. Use equal-weight milestones unless effort differs substantially, and label estimates as approximate. State when blocked or paused. Do not show progress for simple questions or one-step tasks; keep the line last. For completed coding or research work, when a sensible follow-up exists, include a complete, concise, one-line Turkish prompt on a separate line immediately before the progress line: “Sonraki adım promptu: <prompt>”. Do not invent follow-up work, wrap the prompt in quotes/code fences, or execute the suggested prompt automatically.`;
const PROGRESS_LINE = /^\s*(?:\*\*)?İlerleme:\s*(\d+)\s*\/\s*(\d+)\s*\(%\s*(\d{1,3})\s*\)\s*[—-]\s*([^;]+?)(?:;\s*sıradaki:\s*(.+?))?\s*(?:\*\*)?\s*$/iu;
const NEXT_STEP_LINE = /^\s*(?:\*\*)?Sonraki adım promptu:\s*(.+?)\s*(?:\*\*)?\s*$/iu;

interface Progress {
  completed: number;
  total: number;
  percent: number;
  detail: string;
}

class PromptAcceptingEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly getPrompt: () => string | undefined,
    private readonly getGhostText: () => string | undefined,
    private readonly onAccept: () => void,
    private readonly onTextChange: () => void,
  ) {
    super(tui, theme, keybindings);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const suggestion = this.getPrompt();
    if (!suggestion || this.getText().length > 0 || !this.focused || lines.length < 3) return lines;

    const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - paddingX * 2);
    const ghost = truncateToWidth(this.getGhostText() ?? "", Math.max(0, contentWidth - 1), "…");
    const body = `${" ".repeat(paddingX)}${CURSOR_MARKER}${renderFakeCursor(" ")}${ghost}`;
    const bodyWidth = visibleWidth(body.replace(CURSOR_MARKER, ""));
    lines[1] = `${body}${" ".repeat(Math.max(0, width - bodyWidth))}`;
    return lines;
  }

  override handleInput(data: string): void {
    const suggestion = this.getPrompt();
    if (matchesKey(data, "tab") && suggestion && this.getText().length === 0) {
      this.onAccept();
      this.setText(suggestion);
      this.onTextChange();
      return;
    }

    const previousText = this.getText();
    super.handleInput(data);
    if (this.getText() !== previousText) this.onTextChange();
  }
}

type PromptEditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => PromptAcceptingEditor;

function plainText(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseProgress(text: string): Progress | undefined {
  let latest: Progress | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = PROGRESS_LINE.exec(line);
    if (!match) continue;
    const completed = Number(match[1]);
    const total = Number(match[2]);
    const percent = Number(match[3]);
    if (total < 1 || completed > total || percent > 100) continue;
    const detail = Array.from(plainText(match[5] || match[4])).slice(0, 36).join("");
    latest = { completed, total, percent, detail };
  }
  return latest;
}

function parseNextStepPrompt(text: string): string | undefined {
  let latest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = NEXT_STEP_LINE.exec(line);
    if (!match) continue;
    const prompt = plainText(match[1]);
    if (prompt) latest = Array.from(prompt).slice(0, 2000).join("");
  }
  return latest;
}

function assistantText(message: { role: string; content?: unknown }): string | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function setProgress(ctx: ExtensionContext, progress: Progress | undefined): void {
  if (ctx.mode !== "tui") return;
  if (!progress) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const filled = Math.round(progress.percent / 10);
  const bar = `${"#".repeat(filled)}${"-".repeat(10 - filled)}`;
  const text = `İş [${bar}] ${progress.completed}/${progress.total} (%${progress.percent}) · ${progress.detail}`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
}

function setNextStepPrompt(ctx: ExtensionContext, prompt: string | undefined, showWidget = true): void {
  if (ctx.mode !== "tui") return;
  if (!prompt || ctx.ui.getEditorText().length > 0 || !showWidget) {
    ctx.ui.setWidget(NEXT_STEP_WIDGET_KEY, undefined);
    return;
  }

  const promptChars = Array.from(prompt);
  const shownPrompt = promptChars.slice(0, 120).join("");
  const suffix = promptChars.length > 120 ? "…" : "";
  const label = ctx.ui.theme.fg("dim", "Sonraki adım · Tab ile prompt'a al: ");
  const suggestion = ctx.ui.theme.fg("muted", `${shownPrompt}${suffix}`);
  ctx.ui.setWidget(NEXT_STEP_WIDGET_KEY, [`${label}${suggestion}`], { placement: "belowEditor" });
}

function latestAssistantText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return assistantText(entry.message);
  }
  return undefined;
}

function restoreLatestProgress(ctx: ExtensionContext): string {
  const text = latestAssistantText(ctx) ?? "";
  setProgress(ctx, parseProgress(text));
  return text;
}

export default function taskProgressExtension(pi: ExtensionAPI): void {
  let nextStepPrompt: string | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let editorFactory: PromptEditorFactory | undefined;
  let activeContext: ExtensionContext | undefined;

  const renderSuggestion = (ctx: ExtensionContext, prompt: string | undefined): void => {
    const inline = ctx.mode === "tui" && editorFactory !== undefined && ctx.ui.getEditorComponent() === editorFactory;
    setNextStepPrompt(ctx, prompt, !inline);
  };

  const clearSuggestion = (ctx: ExtensionContext): void => {
    nextStepPrompt = undefined;
    renderSuggestion(ctx, undefined);
  };

  const installPromptEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const currentFactory = ctx.ui.getEditorComponent();
    if (currentFactory && currentFactory !== editorFactory) {
      // Preserve another extension's custom editor; use the UI input hook only
      // as a fallback when there is no default editor to extend.
      unsubscribeInput?.();
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        if (matchesKey(data, "tab") && nextStepPrompt && ctx.ui.getEditorText().length === 0) {
          const acceptedPrompt = nextStepPrompt;
          clearSuggestion(ctx);
          ctx.ui.setEditorText(acceptedPrompt);
          return { consume: true };
        }
        if (nextStepPrompt) queueMicrotask(() => setNextStepPrompt(ctx, nextStepPrompt));
        return undefined;
      });
      return;
    }

    unsubscribeInput?.();
    unsubscribeInput = undefined;
    editorFactory ??= (tui, theme, keybindings) => new PromptAcceptingEditor(
      tui,
      theme,
      keybindings,
      () => nextStepPrompt,
      () => activeContext && nextStepPrompt
        ? activeContext.ui.theme.fg("dim", `Tab ↹ ${nextStepPrompt}`)
        : undefined,
      () => {
        if (activeContext) clearSuggestion(activeContext);
      },
      () => {
        if (activeContext) renderSuggestion(activeContext, nextStepPrompt);
      },
    );
    ctx.ui.setEditorComponent(editorFactory);
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    nextStepPrompt = parseNextStepPrompt(restoreLatestProgress(ctx));
    renderSuggestion(ctx, nextStepPrompt);
    installPromptEditor(ctx);
    renderSuggestion(ctx, nextStepPrompt);
  });

  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    nextStepPrompt = parseNextStepPrompt(restoreLatestProgress(ctx));
    renderSuggestion(ctx, nextStepPrompt);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Project APPEND_SYSTEM.md overrides the user-level file. Add the same
    // guidance as a structured system-prompt section when that happens.
    if (!event.systemPromptOptions.appendSystemPrompt.includes("## User-visible task progress")) {
      event.systemPromptOptions.sections.task_progress = PROGRESS_PROMPT_SECTION;
    }
    setProgress(ctx, undefined);
    clearSuggestion(ctx);
  });

  // Update as soon as a complete progress/suggestion line is streamed,
  // including before the model starts a long tool call.
  pi.on("message_update", (event, ctx) => {
    const text = assistantText(event.message);
    if (text === undefined) return;
    const progress = parseProgress(text);
    if (progress) setProgress(ctx, progress);
    const suggestion = parseNextStepPrompt(text);
    if (suggestion) {
      nextStepPrompt = suggestion;
      renderSuggestion(ctx, suggestion);
    }
  });

  pi.on("agent_end", (event, ctx) => {
    let text: string | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      text = assistantText(event.messages[i]);
      if (text !== undefined) break;
    }
    text ??= "";
    setProgress(ctx, parseProgress(text));
    nextStepPrompt = parseNextStepPrompt(text);
    renderSuggestion(ctx, nextStepPrompt);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setProgress(ctx, undefined);
    clearSuggestion(ctx);
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === editorFactory) {
      ctx.ui.setEditorComponent(undefined);
    }
    if (activeContext === ctx) activeContext = undefined;
  });
}
