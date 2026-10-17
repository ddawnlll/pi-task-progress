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
const STATE_KEY = "task-progress-state";
const PROGRESS_PROMPT_SECTION = `For substantial multi-step tasks, define a short, equal-weight set of outcome-based milestones. At kickoff, show their stable numbers and names as a short checklist, for example: - [ ] 1. Veri kontrolü. Give a brief kickoff with 0/N progress. When a milestone is completed, repeat that numbered checklist item with [x] and a short verification result, for example: - [x] 1. Veri kontrolü — doğrulama: eksik kayıt yok. Keep the same numbers and names throughout the task. Count an outcome as complete only after checking it; never invent verification or count tool calls as milestones. During long work, update the user when a milestone completes or before a lengthy phase; do not narrate every tool call. At the bottom of each progress update and final response, use this exact one-line format: İlerleme: 2/5 (%40) — doğrulama sürüyor; sıradaki: raporu gözden geçir. The percentage is the rounded completed/total ratio; it is not a time estimate. Keep the current status before the semicolon, including when blocked or paused. Do not put tracking lines inside examples, quotes, or code fences. Do not show progress for simple questions or one-step tasks. For completed coding or research work, only when a sensible follow-up exists, include a complete, concise, one-line Turkish prompt immediately before the progress line: Sonraki adım promptu: <prompt>. Do not invent follow-up work, wrap the prompt in quotes/code fences, or execute it automatically.`;
const PROGRESS_LINE = /^İlerleme:\s*(\d+)\s*\/\s*(\d+)\s*\(%\s*\d{1,3}\s*\)\s*[—-]\s*([^;]+?)(?:;\s*sıradaki:\s*(.+?))?\s*$/iu;
const NEXT_STEP_LINE = /^Sonraki adım promptu:\s*(.+?)\s*$/iu;
const MILESTONE_LINE = /^(?:[-*+]\s+\[([ x])\]\s+(\d+)[.)]|(\d+)[.)]\s+\[([ x])\])\s+(.+?)\s*$/iu;

interface Progress {
  completed: number;
  total: number;
  percent: number;
  detail: string;
  next?: string;
}

interface Milestone {
  id: string;
  name: string;
  completed: boolean;
  // This records the assistant's verification note, not an independent verifier.
  verification?: string;
}

interface TaskState {
  version: 2;
  progress?: Progress;
  milestones: Milestone[];
  nextStepPrompt?: string;
  settled: boolean;
  outcome?: "aborted" | "error";
}

type AssistantLike = { role: string; content?: unknown; stopReason?: string };

function emptyState(): TaskState {
  return { version: 2, milestones: [], settled: false };
}

function plainText(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(value: string, length: number): string {
  return Array.from(plainText(value)).slice(0, length).join("");
}

// A live stream's last physical line is provisional until a newline arrives.
// Finalized messages also allow a last line without a trailing newline.
function proseLines(text: string, finalized = true): string[] {
  const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "))
    .split(/\r?\n/);
  if (!finalized) lines.pop();
  let fence: { char: string; length: number } | undefined;
  const result: string[] = [];
  for (const line of lines) {
    if (/^(?: {4}|\t| {0,3}>)/u.test(line)) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    result.push(line.trim().replace(/^\*\*(.*)\*\*$/u, "$1"));
  }
  return result;
}

function progressValue(completed: number, total: number, detail: string, next?: string): Progress | undefined {
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < 0 || completed > total) {
    return undefined;
  }
  // Incomplete work must never round up to 100%.
  const percent = completed === total ? 100 : Math.min(99, Math.round((completed / total) * 100));
  return { completed, total, percent, detail: shortText(detail, 300), next: next ? shortText(next, 300) : undefined };
}

function parseProgress(lines: string[]): Progress | undefined {
  let latest: Progress | undefined;
  for (const line of lines) {
    const match = PROGRESS_LINE.exec(line);
    if (!match) continue;
    const progress = progressValue(Number(match[1]), Number(match[2]), match[3], match[4]);
    if (progress) latest = progress;
  }
  return latest;
}

function completePrompt(value: string): string | undefined {
  const prompt = plainText(value);
  // Never silently turn a complete command into a truncated command.
  return prompt && Array.from(prompt).length <= 2000 ? prompt : undefined;
}

function parseNextStepPrompt(lines: string[]): string | undefined {
  let latest: string | undefined;
  for (const line of lines) {
    const match = NEXT_STEP_LINE.exec(line);
    if (match) latest = completePrompt(match[1]);
  }
  return latest;
}

function updateMilestones(state: TaskState, lines: string[]): void {
  for (const line of lines) {
    const match = MILESTONE_LINE.exec(line);
    if (!match) continue;
    const number = Number(match[2] ?? match[3]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const id = String(number);
    const parts = match[5].split(/\s+[—–]\s+doğrulama:\s*/iu);
    const name = shortText(parts[0], 200);
    if (!name) continue;
    const milestone: Milestone = {
      id,
      name,
      completed: (match[1] ?? match[4]).toLowerCase() === "x",
      verification: parts[1] ? shortText(parts.slice(1).join(" — doğrulama: "), 500) : undefined,
    };
    const index = state.milestones.findIndex((item) => item.id === id);
    if (index < 0) {
      if (state.milestones.length < 100) state.milestones.push(milestone);
    } else {
      const previous = state.milestones[index];
      // Repeated completion lines must not erase recorded verification notes.
      state.milestones[index] = {
        ...milestone,
        verification: milestone.completed ? milestone.verification ?? previous.verification : undefined,
      };
    }
  }
  state.milestones.sort((a, b) => Number(a.id) - Number(b.id));
}

function assistantText(message: AssistantLike): string | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

function applyText(state: TaskState, text: string, finalized = true): void {
  const lines = proseLines(text, finalized);
  const progress = parseProgress(lines);
  if (progress) state.progress = progress;
  // Only persist/check off named steps from finalized assistant messages.
  if (finalized) updateMilestones(state, lines);
}

function readState(value: unknown): TaskState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const saved = value as Partial<TaskState>;
  if (saved.version !== 2 || typeof saved.settled !== "boolean" || !Array.isArray(saved.milestones)) return undefined;
  const state = emptyState();
  state.settled = saved.settled;
  if (saved.outcome === "aborted" || saved.outcome === "error") state.outcome = saved.outcome;
  for (const item of saved.milestones.slice(0, 100)) {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.completed !== "boolean") continue;
    if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1) continue;
    if (state.milestones.some((step) => step.id === item.id)) continue;
    state.milestones.push({
      id: item.id,
      name: shortText(item.name, 200),
      completed: item.completed,
      verification: typeof item.verification === "string" ? shortText(item.verification, 500) : undefined,
    });
  }
  if (saved.progress && typeof saved.progress.detail === "string") {
    const p = saved.progress;
    state.progress = progressValue(p.completed, p.total, p.detail, typeof p.next === "string" ? p.next : undefined);
  }
  if (state.settled && !state.outcome && typeof saved.nextStepPrompt === "string") {
    state.nextStepPrompt = completePrompt(saved.nextStepPrompt);
  }
  return state;
}

function restoreState(ctx: ExtensionContext): TaskState {
  let state = emptyState();
  // Replay only the active branch. User boundaries prevent resurrecting an
  // earlier task's progress; snapshots also preserve accepted/cleared prompts.
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_KEY) {
      state = readState(entry.data) ?? state;
    } else if (entry.type === "message") {
      if (entry.message.role === "user") {
        state = emptyState();
      } else if (entry.message.role === "assistant") {
        const message = entry.message;
        const text = assistantText(message);
        const successful = message.stopReason !== "error" && message.stopReason !== "aborted";
        if (successful && text) applyText(state, text, message.stopReason !== "length");
        state.outcome = successful ? undefined : message.stopReason as "error" | "aborted";
        state.settled = message.stopReason === "stop" || !successful;
        state.nextStepPrompt = message.stopReason === "stop" && text
          ? parseNextStepPrompt(proseLines(text)) : undefined;
      }
    }
  }
  return state;
}

function setProgress(ctx: ExtensionContext, state: TaskState): void {
  if (ctx.mode !== "tui") return;
  const progress = state.progress;
  if (!progress) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const filled = progress.percent === 100 ? 10 : Math.min(9, Math.round(progress.percent / 10));
  const bar = `${"#".repeat(filled)}${"-".repeat(10 - filled)}`;
  const outcome = state.outcome === "aborted" ? "iptal edildi · " : state.outcome === "error" ? "hata · " : "";
  const next = progress.next ? `; sıradaki: ${truncateToWidth(progress.next, 36, "…")}` : "";
  const text = `İş [${bar}] ${progress.completed}/${progress.total} (%${progress.percent}) · ${outcome}${truncateToWidth(progress.detail, 48, "…")}${next}`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
}

function setNextStepPrompt(ctx: ExtensionContext, prompt: string | undefined, showWidget = true): void {
  if (ctx.mode !== "tui") return;
  if (!prompt || ctx.ui.getEditorText().length > 0 || !showWidget) {
    ctx.ui.setWidget(NEXT_STEP_WIDGET_KEY, undefined);
    return;
  }
  const label = ctx.ui.theme.fg("dim", "Sonraki adım · Tab ile prompt'a al: ");
  const suggestion = ctx.ui.theme.fg("muted", truncateToWidth(prompt, 120, "…"));
  ctx.ui.setWidget(NEXT_STEP_WIDGET_KEY, [`${label}${suggestion}`], { placement: "belowEditor" });
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
    if (!this.getPrompt() || this.getText().length > 0 || !this.focused || lines.length < 3 || width < 1) return lines;
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
    if (this.focused && matchesKey(data, "tab") && suggestion && this.getText().length === 0) {
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

type PromptEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => PromptAcceptingEditor;

export default function taskProgressExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let pendingSuggestion: string | undefined;
  let lastSnapshot = "";
  let unsubscribeInput: (() => void) | undefined;
  let editorFactory: PromptEditorFactory | undefined;
  let activeContext: ExtensionContext | undefined;
  let uiPromptDepth = 0;

  const persist = (): void => {
    const snapshot = JSON.stringify(state);
    if (snapshot === lastSnapshot) return;
    // appendEntry stores extension metadata outside the model's context.
    pi.appendEntry(STATE_KEY, JSON.parse(snapshot) as TaskState);
    lastSnapshot = snapshot;
  };

  const getSuggestion = (): string | undefined =>
    state.settled && !state.outcome && uiPromptDepth === 0 ? state.nextStepPrompt : undefined;

  const renderSuggestion = (ctx: ExtensionContext): void => {
    const inline = ctx.mode === "tui" && editorFactory !== undefined && ctx.ui.getEditorComponent() === editorFactory;
    setNextStepPrompt(ctx, getSuggestion(), !inline);
  };

  const clearSuggestion = (ctx: ExtensionContext): void => {
    state.nextStepPrompt = undefined;
    pendingSuggestion = undefined;
    persist();
    renderSuggestion(ctx);
  };

  const installPromptEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    const currentFactory = ctx.ui.getEditorComponent();
    if (editorFactory && currentFactory === editorFactory) return;
    if (currentFactory && currentFactory !== editorFactory) {
      // Preserve other extensions' custom editors and the original fallback.
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        const prompt = getSuggestion();
        if (matchesKey(data, "tab") && prompt && ctx.isIdle() && ctx.ui.getEditorText().length === 0) {
          clearSuggestion(ctx);
          ctx.ui.setEditorText(prompt);
          return { consume: true };
        }
        if (prompt) queueMicrotask(() => {
          if (activeContext === ctx) renderSuggestion(ctx);
        });
        return undefined;
      });
      return;
    }
    editorFactory ??= (tui, theme, keybindings) => new PromptAcceptingEditor(
      tui, theme, keybindings,
      getSuggestion,
      () => activeContext && getSuggestion()
        ? activeContext.ui.theme.fg("dim", `Tab ↹ ${getSuggestion()}`) : undefined,
      () => { if (activeContext) clearSuggestion(activeContext); },
      () => { if (activeContext) renderSuggestion(activeContext); },
    );
    ctx.ui.setEditorComponent(editorFactory);
  };

  const restore = (ctx: ExtensionContext): void => {
    activeContext = ctx;
    state = restoreState(ctx);
    pendingSuggestion = undefined;
    uiPromptDepth = 0;
    lastSnapshot = JSON.stringify(state);
    setProgress(ctx, state);
    installPromptEditor(ctx);
    renderSuggestion(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    // Always install the current protocol; an old APPEND_SYSTEM heading alone
    // does not prove that its instructions include the fixed behavior.
    event.systemPromptOptions.sections.task_progress = PROGRESS_PROMPT_SECTION;
    activeContext = ctx;
    state = emptyState();
    pendingSuggestion = undefined;
    persist();
    setProgress(ctx, state);
    renderSuggestion(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    state.settled = false;
    state.nextStepPrompt = undefined;
    state.outcome = undefined;
    pendingSuggestion = undefined;
    renderSuggestion(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    pendingSuggestion = undefined;
    state.settled = false;
    state.nextStepPrompt = undefined;
    renderSuggestion(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const text = assistantText(event.message);
    if (!text) return;
    applyText(state, text, false);
    setProgress(ctx, state);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    const text = assistantText(message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      state.outcome = message.stopReason;
      pendingSuggestion = undefined;
    } else {
      state.outcome = undefined;
      if (text) applyText(state, text, message.stopReason !== "length");
      pendingSuggestion = message.stopReason === "stop" && text
        ? parseNextStepPrompt(proseLines(text)) : undefined;
    }
    persist();
    setProgress(ctx, state);
  });

  // agent_end can be followed by automatic retry, compaction or queued work.
  // Keep the last valid progress and wait for final settlement to offer Tab.
  pi.on("agent_end", (_event, ctx) => setProgress(ctx, state));

  pi.on("agent_before_settle", (event) => {
    state.outcome = event.outcome === "aborted" || event.outcome === "error" ? event.outcome : undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) state.outcome = "aborted";
    state.settled = true;
    state.nextStepPrompt = state.outcome ? undefined : pendingSuggestion;
    pendingSuggestion = undefined;
    persist();
    setProgress(ctx, state);
    renderSuggestion(ctx);
  });

  pi.on("ui_prompt_start", (_event, ctx) => {
    uiPromptDepth++;
    renderSuggestion(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    uiPromptDepth = Math.max(0, uiPromptDepth - 1);
    renderSuggestion(ctx);
  });

  pi.registerCommand("asamalar", {
    description: "Görevin kayıtlı aşamalarını ve doğrulama notlarını göster",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (!state.milestones.length) {
        ctx.ui.notify("Henüz kayıtlı aşama listesi yok.", "info");
        return;
      }
      await ctx.ui.select("Aşamalar", state.milestones.map((item) =>
        `[${item.completed ? "x" : " "}] ${item.id}. ${item.name}${item.verification ? ` — doğrulama: ${item.verification}` : ""}`,
      ));
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    persist();
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(NEXT_STEP_WIDGET_KEY, undefined);
    }
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === editorFactory) ctx.ui.setEditorComponent(undefined);
    if (activeContext === ctx) activeContext = undefined;
  });
}
