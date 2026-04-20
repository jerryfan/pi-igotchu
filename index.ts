import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { Text, matchesKey, type AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// HARD CUTOVER (2026-04-20): igotchu is no longer an autocomplete/prefill extension.
// It is now a drift monitor with a /yo command and a one-token footer status: "<glyph> yo".

type ModelMode = "auto" | "pinned";

type NudgeKind = "none" | "break" | "summarize" | "refocus";

type YoConfig = {
	enabled: boolean;
	/** Confidence gate for user-facing nudges. HARD CLAMP: 95-99. */
	threshold: number;
	/** Drift (0-100) at which we may nudge (still requires confidence>=threshold). */
	nudgeThreshold: number;
	debounceMs: number;
	updateEveryTurns: number;
	cooldownMs: number;
	modelMode: ModelMode;
	pinnedModel: string | null; // provider/id
	minContextWindow: number;
	minMaxTokens: number;
	maxReasonChars: number;
	maxAdviceChars: number;
};

type DriftRow = {
	id: number;
	ts: string;
	mode: "heuristic" | "cheap" | "deep";
	model: string;
	drift: number;
	confidence: number;
	nudge: NudgeKind;
	reason?: string;
	shown?: boolean;
};

type PersistedState = {
	schemaVersion: 2;
	nextRowId: number;
	lastSyncAt: string | null;
	lastNudgeAt: string | null;
	rows: DriftRow[];
};

type DriftVerdict = {
	drift: number;
	confidence: number;
	nudge: NudgeKind;
	reason: string;
	advice?: string;
};

type MemoryCache = {
	path: string;
	mtimeMs: number;
	size: number;
	text: string;
	userNotes: string;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "igotchu.json");
const STATE_PATH = join(homedir(), ".pi", "agent", "state", "igotchu.json");

const DEFAULT_CONFIG: YoConfig = {
	enabled: true,
	threshold: 95,
	nudgeThreshold: 85,
	debounceMs: 350,
	updateEveryTurns: 2,
	cooldownMs: 20 * 60_000,
	modelMode: "auto",
	pinnedModel: null,
	minContextWindow: 32_000,
	minMaxTokens: 2_000,
	maxReasonChars: 140,
	maxAdviceChars: 700,
};

// --- i18n (optional; integrates with pi-i18n if installed) ---
// igotchu must remain usable without pi-i18n, so we keep an English fallback.

type PiI18nApi = {
	getLocale(): string;
	t(fullKey: string, params?: Record<string, string | number>): string;
	registerBundle(bundle: any): { ok: boolean; errors: string[] };
};

const IGOTCHU_BASE_DIR = dirname(fileURLToPath(import.meta.url));

const IGOTCHU_EN_BUNDLE = (() => {
	try {
		return JSON.parse(readFileSync(join(IGOTCHU_BASE_DIR, "locales", "en.json"), "utf-8")) as {
			messages?: Record<string, any>;
		};
	} catch {
		return { messages: {} };
	}
})();

function formatTemplate(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name: string) => {
		const v = params[name];
		return v === undefined || v === null ? `{${name}}` : String(v);
	});
}

function fallbackT(key: string, params?: Record<string, string | number>): string {
	const raw = (IGOTCHU_EN_BUNDLE.messages ?? {})[key];
	if (typeof raw === "string") return formatTemplate(raw, params);
	if (raw && typeof raw === "object" && typeof raw.value === "string") return formatTemplate(raw.value, params);
	return key;
}

function requestPiI18n(pi: ExtensionAPI): PiI18nApi | null {
	let api: PiI18nApi | null = null;
	try {
		pi.events.emit("pi-i18n/requestApi", {
			reply: (a: PiI18nApi) => {
				api = a;
			},
		});
	} catch {
		// ignore
	}
	return api;
}

function registerIgotchuBundles(api: PiI18nApi): void {
	try {
		const dir = join(IGOTCHU_BASE_DIR, "locales");
		const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
		for (const f of files) {
			try {
				api.registerBundle(JSON.parse(readFileSync(join(dir, f), "utf-8")));
			} catch {
				// ignore invalid bundle
			}
		}
	} catch {
		// ignore
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function nowIso(): string {
	return new Date().toISOString();
}

function safeReadJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

async function atomicWriteText(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, path);
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

function loadConfig(): YoConfig {
	const cfg = safeReadJson<Record<string, unknown>>(CONFIG_PATH) ?? {};
	// Migrate: legacy igotchu threshold could be <95. Hard clamp for /yo.
	const rawThreshold = Number(cfg.threshold ?? DEFAULT_CONFIG.threshold);
	const threshold = clamp(Number.isFinite(rawThreshold) ? rawThreshold : DEFAULT_CONFIG.threshold, 95, 99);

	const rawNudge = Number((cfg as any).nudgeThreshold ?? DEFAULT_CONFIG.nudgeThreshold);
	const nudgeThreshold = clamp(Number.isFinite(rawNudge) ? rawNudge : DEFAULT_CONFIG.nudgeThreshold, 0, 100);

	const modelMode = (cfg as any).modelMode === "pinned" ? "pinned" : "auto";
	const pinnedModel = typeof (cfg as any).pinnedModel === "string" && (cfg as any).pinnedModel.trim()
		? String((cfg as any).pinnedModel).trim()
		: null;

	return {
		...DEFAULT_CONFIG,
		enabled: (cfg as any).enabled ?? DEFAULT_CONFIG.enabled,
		threshold,
		nudgeThreshold,
		debounceMs: Math.max(120, Number((cfg as any).debounceMs ?? DEFAULT_CONFIG.debounceMs)),
		updateEveryTurns: Math.max(1, Number((cfg as any).updateEveryTurns ?? DEFAULT_CONFIG.updateEveryTurns)),
		cooldownMs: Math.max(30_000, Number((cfg as any).cooldownMs ?? DEFAULT_CONFIG.cooldownMs)),
		modelMode,
		pinnedModel,
		minContextWindow: Math.max(4_096, Number((cfg as any).minContextWindow ?? DEFAULT_CONFIG.minContextWindow)),
		minMaxTokens: Math.max(256, Number((cfg as any).minMaxTokens ?? DEFAULT_CONFIG.minMaxTokens)),
		maxReasonChars: clamp(Number((cfg as any).maxReasonChars ?? DEFAULT_CONFIG.maxReasonChars), 60, 400),
		maxAdviceChars: clamp(Number((cfg as any).maxAdviceChars ?? DEFAULT_CONFIG.maxAdviceChars), 120, 2500),
	};
}

function defaultState(): PersistedState {
	return {
		schemaVersion: 2,
		nextRowId: 1,
		lastSyncAt: null,
		lastNudgeAt: null,
		rows: [],
	};
}

function loadState(): PersistedState {
	const parsed = safeReadJson<any>(STATE_PATH);
	if (!parsed) return defaultState();
	if (parsed.schemaVersion === 2) {
		return {
			schemaVersion: 2,
			nextRowId: Math.max(1, Number(parsed.nextRowId || 1)),
			lastSyncAt: parsed.lastSyncAt ?? null,
			lastNudgeAt: parsed.lastNudgeAt ?? null,
			rows: Array.isArray(parsed.rows) ? parsed.rows.slice(-220) : [],
		};
	}

	// Legacy v1 state migration: keep minimal provenance.
	if (parsed.schemaVersion === 1 && Array.isArray(parsed.provenance)) {
		const rows: DriftRow[] = parsed.provenance.slice(-120).map((r: any, i: number) => ({
			id: i + 1,
			ts: String(r.ts ?? nowIso()),
			mode: "heuristic",
			model: String(r.model ?? "(legacy)"),
			drift: 0,
			confidence: clamp(Number(r.confidence ?? 0), 0, 100),
			nudge: "none",
			reason: "legacy igotchu provenance",
			shown: false,
		}));
		return {
			schemaVersion: 2,
			nextRowId: rows.length + 1,
			lastSyncAt: parsed.lastSyncAt ?? null,
			lastNudgeAt: null,
			rows,
		};
	}

	return defaultState();
}

function parseModelRef(ref: string): { provider: string; id: string } | null {
	const v = ref.trim();
	const slash = v.indexOf("/");
	if (slash <= 0 || slash >= v.length - 1) return null;
	return { provider: v.slice(0, slash), id: v.slice(slash + 1) };
}

function modelRef(model: Model<Api> | undefined): string {
	if (!model) return "(none)";
	return `${model.provider}/${model.id}`;
}

function modelScore(model: Model<Api>): number {
	const c = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return c.input * 1.0 + c.output * 1.2;
}

function chooseCheapModel(ctx: any, config: YoConfig): { model: Model<Api> | null; reason: string } {
	const available = (ctx.modelRegistry.getAvailable() as Model<Api>[]).filter((m) => m.input.includes("text"));
	if (available.length === 0) return { model: null, reason: "no available text models" };

	if (config.modelMode === "pinned" && config.pinnedModel) {
		const parsed = parseModelRef(config.pinnedModel);
		if (parsed) {
			const pinned = available.find((m) => m.provider === parsed.provider && m.id === parsed.id);
			if (pinned) return { model: pinned, reason: "pinned model" };
		}
	}

	const viable = available.filter((m) => m.contextWindow >= config.minContextWindow && m.maxTokens >= config.minMaxTokens);
	const pool = viable.length > 0 ? viable : available;

	const sorted = [...pool].sort((a, b) => {
		if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1; // prefer reasoning if present
		return modelScore(a) - modelScore(b);
	});

	return {
		model: sorted[0] ?? null,
		reason: viable.length > 0 ? "auto cheapest viable (reasoning-preferred)" : "auto cheapest available fallback",
	};
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function parseDriftJson(raw: string): DriftVerdict | null {
	const source = String(raw ?? "").trim();
	if (!source) return null;

	const tryParse = (s: string): DriftVerdict | null => {
		try {
			const obj = JSON.parse(s) as any;
			const drift = clamp(Number(obj.drift ?? 0), 0, 100);
			const confidence = clamp(Number(obj.confidence ?? 0), 0, 100);
			const nudgeRaw = String(obj.nudge ?? "none").toLowerCase();
			const nudge: NudgeKind = nudgeRaw === "break" || nudgeRaw === "summarize" || nudgeRaw === "refocus" ? nudgeRaw : "none";
			const reason = String(obj.reason ?? "").replace(/\r/g, "").trim();
			const advice = obj.advice === undefined ? undefined : String(obj.advice ?? "").replace(/\r/g, "").trim();
			return { drift, confidence, nudge, reason, ...(advice ? { advice } : {}) };
		} catch {
			return null;
		}
	};

	const direct = tryParse(source);
	if (direct) return direct;

	const block = source.match(/\{[\s\S]*\}/);
	if (block?.[0]) return tryParse(block[0]);

	return null;
}

function memoryPathFor(ctx: any): string {
	return join(ctx.sessionManager.getCwd(), ".igotchu.md");
}

function extractUserNotes(md: string): string {
	const start = "<!-- yo:user-notes:start -->";
	const end = "<!-- yo:user-notes:end -->";
	const a = md.indexOf(start);
	const b = md.indexOf(end);
	if (a !== -1 && b !== -1 && b > a) {
		return md.slice(a + start.length, b).trimEnd().replace(/^\n/, "");
	}

	// Migration fallback: older .igotchu.md files (and user-authored memory) may not
	// have markers. Preserve the entire file as "notes" rather than silently
	// discarding it on first sync.
	return String(md ?? "").trimEnd();
}

function renderMemoryMarkdown(opts: {
	ctx: any;
	config: YoConfig;
	selectedModel: Model<Api> | null;
	state: PersistedState;
	last: { drift: number; confidence: number; nudge: NudgeKind; reason: string | null };
	userNotes: string;
	t: (key: string, params?: Record<string, string | number>) => string;
}): string {
	const { ctx, config, selectedModel, state, last, userNotes, t } = opts;
	const rows = state.rows.slice(-24);

	const lines: string[] = [];
	lines.push("---");
	lines.push("yo: 1");
	lines.push(`updated_at: ${nowIso()}`);
	lines.push(`session_id: ${ctx.sessionManager.getSessionFile?.() ?? "(ephemeral)"}`);
	lines.push(`confidence_threshold: ${config.threshold}`);
	lines.push(`nudge_drift_threshold: ${config.nudgeThreshold}`);
	lines.push(`cheap_model: ${modelRef(selectedModel ?? undefined)}`);
	lines.push("---");
	lines.push("");
	lines.push(t("md.title"));
	lines.push(t("md.purpose"));
	lines.push(t("md.footerToken"));
	lines.push("");
	lines.push(t("md.section.current"));
	lines.push(`- drift: ${Math.round(last.drift)}`);
	lines.push(`- confidence: ${Math.round(last.confidence)}`);
	lines.push(`- last_nudge: ${state.lastNudgeAt ?? t("common.never")}`);
	if (last.reason) lines.push(`- reason: ${last.reason.replace(/\s+/g, " ").slice(0, config.maxReasonChars)}`);
	lines.push("");
	lines.push(t("md.section.driftLog"));
	lines.push("- ts | mode | model | drift | conf | nudge | shown | reason");
	for (const r of rows) {
		const reason = (r.reason ?? "").replace(/\s+/g, " ").slice(0, config.maxReasonChars);
		lines.push(
			`- ${r.ts} | ${r.mode} | ${r.model} | ${Math.round(r.drift)} | ${Math.round(r.confidence)} | ${r.nudge} | ${r.shown ? t("common.yes") : t("common.no")} | ${reason}`,
		);
	}
	lines.push("");
	lines.push(t("md.section.userNotes"));
	lines.push("<!-- yo:user-notes:start -->");
	if (userNotes.trim()) lines.push(userNotes.trimEnd());
	lines.push("<!-- yo:user-notes:end -->");
	lines.push("");
	return lines.join("\n") + "\n";
}

function tokenize(s: string): string[] {
	const cleaned = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	if (!cleaned) return [];
	const stop = new Set([
		"the",
		"and",
		"for",
		"with",
		"that",
		"this",
		"you",
		"your",
		"but",
		"are",
		"was",
		"were",
		"have",
		"has",
		"had",
		"not",
		"from",
		"into",
		"then",
		"than",
		"just",
		"like",
		"what",
		"how",
	]);
	return cleaned
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3 && !stop.has(t));
}

function jaccardDistance(a: string, b: string): number {
	const ta = new Set(tokenize(a));
	const tb = new Set(tokenize(b));
	if (ta.size === 0 && tb.size === 0) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	const union = ta.size + tb.size - inter;
	if (union <= 0) return 0;
	return 1 - inter / union;
}

function getRecentTexts(ctx: any, maxUser = 6, maxAssistant = 4): { user: string[]; assistant: string[] } {
	const branch = (ctx.sessionManager.getBranch?.() ?? []) as any[];
	const user: string[] = [];
	const assistant: string[] = [];
	for (let i = branch.length - 1; i >= 0 && (user.length < maxUser || assistant.length < maxAssistant); i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		const text = extractText(msg.content ?? []).trim();
		if (!text) continue;
		if (msg.role === "user" && user.length < maxUser) user.push(text);
		else if (msg.role === "assistant" && assistant.length < maxAssistant) assistant.push(text);
	}
	return { user: user.reverse(), assistant: assistant.reverse() };
}

function heuristicDrift(ctx: any): { drift: number; reason: string; shouldModel: boolean } {
	const { user } = getRecentTexts(ctx, 4, 0);
	const last = user[user.length - 1] ?? "";
	const prev = user[user.length - 2] ?? "";

	const dist = last && prev ? jaccardDistance(last, prev) : 0;
	const correctionHints = ["actually", "ignore", "scratch", "never mind", "instead", "new plan", "wait", "no,"];
	const metaHints = ["what are we doing", "remind", "status", "where were we", "recap", "summary"];
	const lower = last.toLowerCase();
	const correction = correctionHints.some((h) => lower.includes(h)) ? 1 : 0;
	const meta = metaHints.some((h) => lower.includes(h)) ? 1 : 0;

	const drift = clamp(Math.round(dist * 70 + correction * 18 + meta * 12), 0, 100);
	const reasonParts: string[] = [];
	if (dist >= 0.65) reasonParts.push("topic shift");
	if (correction) reasonParts.push("correction language");
	if (meta) reasonParts.push("meta/recap request");
	const reason = reasonParts.length ? reasonParts.join(", ") : "stable";

	// Cheap model call only when heuristics are suspicious.
	const shouldModel = drift >= 45 || correction === 1 || meta === 1;
	return { drift, reason, shouldModel };
}

async function runCheapVerdict(ctx: any, model: Model<Api>, memoryText: string, signal: AbortSignal): Promise<DriftVerdict | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

	const recent = getRecentTexts(ctx, 6, 4);
	const memoryExcerpt = memoryText.length > 3500 ? memoryText.slice(memoryText.length - 3500) : memoryText;
	const editor = (ctx.hasUI ? String(ctx.ui.getEditorText?.() ?? "") : "").trim();
	const editorExcerpt = editor.length > 700 ? editor.slice(editor.length - 700) : editor;

	const user: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`RECENT_USER:\n${recent.user.join("\n---\n") || "(none)"}\n\n` +
					`RECENT_ASSISTANT:\n${recent.assistant.join("\n---\n") || "(none)"}\n\n` +
					`EDITOR_EXCERPT:\n${editorExcerpt || "(empty)"}\n\n` +
					`PROJECT_MEMORY(.igotchu.md)\n${memoryExcerpt || "(empty)"}`,
			},
		],
		timestamp: Date.now(),
	};

	const systemPrompt =
		"You are yo, a context drift monitor. Return STRICT JSON only with keys: " +
		"drift (0-100 number), confidence (0-100 number), nudge (none|break|summarize|refocus), reason (string). " +
		"If unsure, set low confidence. Keep reason <= 140 chars.";

	const response = await complete(model, { systemPrompt, messages: [user] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
	if (response.stopReason === "aborted") return null;
	const raw = extractText(response.content as Array<{ type: string; text?: string }>);
	const parsed = parseDriftJson(raw);
	if (!parsed) return null;
	parsed.reason = parsed.reason.replace(/\s+/g, " ").slice(0, 140);
	return parsed;
}

async function runDeepVerdict(ctx: any, memoryText: string, signal: AbortSignal): Promise<DriftVerdict | null> {
	if (!ctx.model) throw new Error("error.noChatModelSelected");
	const model = ctx.model as Model<Api>;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

	const recent = getRecentTexts(ctx, 8, 6);
	const memoryExcerpt = memoryText.length > 6000 ? memoryText.slice(memoryText.length - 6000) : memoryText;
	const editor = (ctx.hasUI ? String(ctx.ui.getEditorText?.() ?? "") : "").trim();
	const editorExcerpt = editor.length > 1200 ? editor.slice(editor.length - 1200) : editor;

	const user: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text:
					"Analyze drift risk and propose next steps.\n\n" +
					`RECENT_USER:\n${recent.user.join("\n---\n") || "(none)"}\n\n` +
					`RECENT_ASSISTANT:\n${recent.assistant.join("\n---\n") || "(none)"}\n\n` +
					`EDITOR_EXCERPT:\n${editorExcerpt || "(empty)"}\n\n` +
					`PROJECT_MEMORY(.igotchu.md)\n${memoryExcerpt || "(empty)"}`,
			},
		],
		timestamp: Date.now(),
	};

	const systemPrompt =
		"You are yo (deep). Return STRICT JSON only with keys: drift (0-100), confidence (0-100), nudge (none|break|summarize|refocus), reason (<=160 chars), advice (<=700 chars).";

	const response = await complete(model, { systemPrompt, messages: [user] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
	if (response.stopReason === "aborted") return null;
	const raw = extractText(response.content as Array<{ type: string; text?: string }>);
	const parsed = parseDriftJson(raw);
	if (!parsed) return null;
	parsed.reason = parsed.reason.replace(/\s+/g, " ").slice(0, 160);
	if (parsed.advice) parsed.advice = parsed.advice.replace(/\s+/g, " ").slice(0, DEFAULT_CONFIG.maxAdviceChars);
	return parsed;
}

function parseIso(s: string | null): number | null {
	if (!s) return null;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

function formatCooldownRemaining(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rem = m % 60;
	return rem ? `${h}h${rem}m` : `${h}h`;
}

function glyphForYo(cfg: YoConfig, last: { drift: number; confidence: number }, enabled: boolean, hasError: boolean): string {
	if (!enabled) return "✕";
	if (hasError) return "✕";
	if (last.confidence >= cfg.threshold && last.drift >= cfg.nudgeThreshold) return "●";
	if (last.drift >= 85) return "◕";
	if (last.drift >= 65) return "◑";
	if (last.drift >= 45) return "◔";
	return "○";
}

export default function yoExtension(pi: ExtensionAPI) {
	let config: YoConfig = loadConfig();
	let state: PersistedState = loadState();

	let piI18n: PiI18nApi | null = null;
	let bundlesRegistered = false;
	const bindI18n = () => {
		if (!piI18n) piI18n = requestPiI18n(pi);
		if (piI18n && !bundlesRegistered) {
			registerIgotchuBundles(piI18n);
			bundlesRegistered = true;
		}
	};
	const t = (key: string, params?: Record<string, string | number>) =>
		piI18n ? piI18n.t(`ext.igotchu.${key}`, params) : fallbackT(key, params);

	bindI18n();

	let selectedModel: Model<Api> | null = null;
	let selectedModelReason = "";

	let lastCtx: any = null; // for dynamic completions

	let driftTimer: ReturnType<typeof setTimeout> | null = null;
	let driftAbort: AbortController | null = null;
	let driftSeq = 0;
	let turnsSinceEval = 0;

	let lastDrift = 0;
	let lastConfidence = 0;
	let lastNudge: NudgeKind = "none";
	let lastReason: string | null = null;
	let lastAdvice: string | null = null;
	let lastError: string | null = null;

	let memoryCache: MemoryCache | null = null;

	async function persistConfig(): Promise<void> {
		await atomicWriteJson(CONFIG_PATH, config);
	}

	async function persistState(): Promise<void> {
		await atomicWriteJson(STATE_PATH, state);
	}

	function pushRow(row: Omit<DriftRow, "id">) {
		const id = state.nextRowId++;
		state.rows.push({ id, ...row });
		if (state.rows.length > 220) state.rows = state.rows.slice(-220);
	}

	function selectCheapModel(ctx: any, notify = false) {
		const picked = chooseCheapModel(ctx, config);
		selectedModel = picked.model;
		selectedModelReason = picked.reason;
		if (notify && ctx.hasUI) {
			if (selectedModel) ctx.ui.notify(t("notify.model", { model: modelRef(selectedModel), reason: selectedModelReason }), "info");
			else ctx.ui.notify(t("notify.noCheapModel"), "warning");
		}
	}

	function ensureSelectedModel(ctx: any) {
		const available = (ctx.modelRegistry.getAvailable() as Model<Api>[]).filter((m) => m.input.includes("text"));
		const exists = selectedModel
			? available.some((m) => m.provider === selectedModel!.provider && m.id === selectedModel!.id)
			: false;

		if (!exists) {
			selectCheapModel(ctx, false);
			return;
		}

		if (config.modelMode === "auto") {
			const picked = chooseCheapModel(ctx, config);
			if (!picked.model) {
				selectedModel = null;
				selectedModelReason = picked.reason;
				return;
			}
			if (picked.model.provider !== selectedModel!.provider || picked.model.id !== selectedModel!.id) {
				selectedModel = picked.model;
				selectedModelReason = picked.reason;
			}
		}
	}

	function setFooterStatus(ctx: any) {
		if (!ctx.hasUI) return;
		const glyph = glyphForYo(config, { drift: lastDrift, confidence: lastConfidence }, config.enabled, lastError !== null);
		ctx.ui.setStatus("yo", `${glyph} yo`);
	}

	async function ensureMemoryLoaded(ctx: any): Promise<{ text: string; userNotes: string }> {
		const path = memoryPathFor(ctx);
		try {
			if (!existsSync(path)) {
				memoryCache = { path, mtimeMs: 0, size: 0, text: "", userNotes: "" };
				return { text: "", userNotes: "" };
			}
			const st = await stat(path);
			if (memoryCache && memoryCache.path === path && memoryCache.mtimeMs === st.mtimeMs && memoryCache.size === st.size) {
				return { text: memoryCache.text, userNotes: memoryCache.userNotes };
			}
			const text = await readFile(path, "utf8");
			const userNotes = extractUserNotes(text);
			memoryCache = { path, mtimeMs: st.mtimeMs, size: st.size, text, userNotes };
			return { text, userNotes };
		} catch {
			memoryCache = { path, mtimeMs: 0, size: 0, text: "", userNotes: "" };
			return { text: "", userNotes: "" };
		}
	}

	async function syncMemory(ctx: any, reason: "periodic" | "manual" | "reset" | "shutdown") {
		try {
			const loaded = await ensureMemoryLoaded(ctx);
			const md = renderMemoryMarkdown({
				ctx,
				config,
				selectedModel,
				state,
				last: { drift: lastDrift, confidence: lastConfidence, nudge: lastNudge, reason: lastReason },
				userNotes: loaded.userNotes,
				t,
			});
			const path = memoryPathFor(ctx);
			await atomicWriteText(path, md);
			state.lastSyncAt = nowIso();
			await persistState();
			// Refresh cache (best-effort; stat() gives updated mtime).
			try {
				const st = await stat(path);
				memoryCache = { path, mtimeMs: st.mtimeMs, size: st.size, text: md, userNotes: loaded.userNotes };
			} catch {
				memoryCache = { path, mtimeMs: 0, size: 0, text: md, userNotes: loaded.userNotes };
			}
			if (ctx.hasUI && (reason === "manual" || reason === "reset")) {
				ctx.ui.notify(t("notify.synced", { reason }), "info");
			}
		} catch (e: any) {
			lastError = String(e?.message ?? e);
			if (ctx.hasUI) ctx.ui.notify(t("notify.syncFailed", { error: lastError }), "warning");
		}
		setFooterStatus(ctx);
	}

	function clearDriftWork() {
		if (driftTimer) clearTimeout(driftTimer);
		driftTimer = null;
		if (driftAbort) driftAbort.abort();
		driftAbort = null;
	}

	function maybeNudge(ctx: any, verdict: DriftVerdict, shownSource: "cheap" | "deep") {
		if (!ctx.hasUI) return;
		if (!config.enabled) return;
		if (verdict.confidence < config.threshold) return;
		if (verdict.drift < config.nudgeThreshold) return;

		const lastAtMs = parseIso(state.lastNudgeAt);
		const now = Date.now();
		if (lastAtMs !== null && now - lastAtMs < config.cooldownMs) return;

		const suggestion =
			verdict.nudge === "break"
				? t("suggestion.break")
				: verdict.nudge === "summarize"
					? t("suggestion.summarize")
					: verdict.nudge === "refocus"
						? t("suggestion.refocus")
						: t("suggestion.pause");

		ctx.ui.notify(t("notify.driftHigh", { suggestion }), "warning");
		state.lastNudgeAt = nowIso();
		pushRow({
			ts: nowIso(),
			mode: shownSource,
			model: shownSource === "cheap" ? modelRef(selectedModel ?? undefined) : modelRef(ctx.model as Model<Api> | undefined),
			drift: verdict.drift,
			confidence: verdict.confidence,
			nudge: verdict.nudge,
			reason: verdict.reason,
			shown: true,
		});
		void persistState();
	}

	async function runDriftCycle(ctx: any, reason: "turn_end" | "manual") {
		if (!config.enabled) return;
		if (!ctx.isIdle()) return;
		ensureSelectedModel(ctx);
		if (!selectedModel) {
			lastError = "no cheap model available";
			setFooterStatus(ctx);
			return;
		}

		const seq = ++driftSeq;
		if (driftAbort) driftAbort.abort();
		driftAbort = new AbortController();
		const signal = driftAbort.signal;
		lastError = null;

		const heur = heuristicDrift(ctx);
		lastDrift = heur.drift;
		lastConfidence = 0;
		lastNudge = "none";
		lastReason = heur.reason;
		lastAdvice = null;

		pushRow({
			ts: nowIso(),
			mode: "heuristic",
			model: "(none)",
			drift: heur.drift,
			confidence: 0,
			nudge: "none",
			reason: heur.reason,
			shown: false,
		});

		setFooterStatus(ctx);
		void persistState();

		const dueByTurns = turnsSinceEval >= config.updateEveryTurns;
		if (!heur.shouldModel && !dueByTurns && reason !== "manual") return;

		turnsSinceEval = 0;
		try {
			const mem = await ensureMemoryLoaded(ctx);
			const verdict = await runCheapVerdict(ctx, selectedModel!, mem.text, signal);
			if (!verdict || signal.aborted || seq !== driftSeq) return;

			lastDrift = verdict.drift;
			lastConfidence = verdict.confidence;
			lastNudge = verdict.nudge;
			lastReason = verdict.reason;
			lastAdvice = null;

			pushRow({
				ts: nowIso(),
				mode: "cheap",
				model: modelRef(selectedModel!),
				drift: verdict.drift,
				confidence: verdict.confidence,
				nudge: verdict.nudge,
				reason: verdict.reason,
				shown: false,
			});

			setFooterStatus(ctx);
			void persistState();
			maybeNudge(ctx, verdict, "cheap");
		} catch (e: any) {
			if (signal.aborted) return;
			lastError = String(e?.message ?? e);
			if (/no api key|not available|unauthorized|forbidden|401|403/i.test(lastError)) {
				selectedModel = null; // force reselection on next cycle
			}
			setFooterStatus(ctx);
		}
	}

	function scheduleDrift(ctx: any, reason: "turn_end" | "manual") {
		if (!config.enabled) return;
		if (driftTimer) clearTimeout(driftTimer);

		const retryMs = reason === "manual" ? 250 : Math.max(250, config.debounceMs);
		const maxAttempts = reason === "manual" ? 40 : 6;
		let attempts = 0;

		const tick = () => {
			driftTimer = null;
			if (!config.enabled) return;
			if (ctx.isIdle()) {
				void runDriftCycle(ctx, reason);
				return;
			}
			attempts++;
			if (attempts >= maxAttempts) return;
			driftTimer = setTimeout(tick, retryMs);
		};

		driftTimer = setTimeout(tick, config.debounceMs);
	}

	function buildStatusLine(): string {
		const pieces: string[] = [];
		pieces.push(`${t("status.enabled")}=${config.enabled ? t("status.on") : t("status.off")}`);
		pieces.push(`${t("status.threshold")}=${config.threshold}`);
		pieces.push(`${t("status.nudge")}=${config.nudgeThreshold}`);
		pieces.push(`${t("status.drift")}=${Math.round(lastDrift)}`);
		pieces.push(`${t("status.conf")}=${Math.round(lastConfidence)}`);
		pieces.push(`${t("status.model")}=${modelRef(selectedModel ?? undefined)}`);
		pieces.push(`${t("status.mode")}=${config.modelMode}`);
		if (state.lastNudgeAt) {
			const at = parseIso(state.lastNudgeAt);
			if (at != null) {
				const remaining = config.cooldownMs - (Date.now() - at);
				if (remaining > 0) pieces.push(`${t("status.cooldown")}=${formatCooldownRemaining(remaining)}`);
			}
		}
		pieces.push(`${t("status.lastSync")}=${state.lastSyncAt ?? t("common.never")}`);
		pieces.push(`${t("status.error")}=${lastError ? lastError.slice(0, 80) : t("common.none")}`);
		return pieces.join(" • ");
	}

	async function openReport(ctx: any): Promise<void> {
		const header = t("report.title");
		const last = state.rows.slice(-10);
		const lines: string[] = [];
		lines.push(header);
		lines.push("");
		lines.push(buildStatusLine());
		if (lastReason) lines.push(t("report.reason", { reason: lastReason }));
		if (lastAdvice) lines.push("");
		if (lastAdvice) lines.push(t("report.advice", { advice: lastAdvice }));
		lines.push("");
		lines.push(t("report.recent"));
		for (const r of last) {
			lines.push(
				`- ${r.ts} ${r.mode} drift=${Math.round(r.drift)} conf=${Math.round(r.confidence)} nudge=${r.nudge}${r.shown ? t("report.shownSuffix") : ""}${r.reason ? ` :: ${r.reason}` : ""}`,
			);
		}
		const text = lines.join("\n");

		if (!ctx.hasUI) return;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const body = new Text(theme.bold(" yo ") + theme.fg("dim", t("report.closeHint")) + "\n\n" + text, 1, 0);
					return {
						render: (w: number) => body.render(w),
						invalidate: () => body.invalidate(),
						handleInput: (data: string) => {
							if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
								done(undefined);
								return;
							}
							// allow ctrl+c etc to propagate? ignore.
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "58%",
						minWidth: 72,
						maxHeight: "92%",
						margin: 1,
					},
				},
			);
		} catch {
			// Fallback: notify (may be truncated, but better than nothing).
			ctx.ui.notify(text.slice(0, 900), "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		bindI18n();
		lastCtx = ctx;
		// Hard cutover: clear any legacy status key from older builds.
		if (ctx.hasUI) ctx.ui.setStatus("igotchu", undefined);
		config = loadConfig();
		state = loadState();
		selectedModel = null;
		selectedModelReason = "";
		turnsSinceEval = 0;
		lastDrift = 0;
		lastConfidence = 0;
		lastNudge = "none";
		lastReason = null;
		lastAdvice = null;
		lastError = null;
		memoryCache = null;
		clearDriftWork();

		selectCheapModel(ctx, false);
		await ensureMemoryLoaded(ctx);
		setFooterStatus(ctx);
		// First pass (with idle-retry): run an initial manual drift cycle after start/resume.
		scheduleDrift(ctx, "manual");
	});

	pi.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		ensureSelectedModel(ctx);
		lastError = null;
		setFooterStatus(ctx);
		if (config.enabled) scheduleDrift(ctx, "manual");
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!config.enabled) return;
		turnsSinceEval++;
		scheduleDrift(ctx, "turn_end");
		// keep memory synced periodically (silent).
		if (turnsSinceEval % Math.max(2, config.updateEveryTurns) === 0) {
			void syncMemory(ctx, "periodic");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearDriftWork();
		if (config.enabled) {
			try {
				await syncMemory(ctx, "shutdown");
			} catch {
				// ignore
			}
		}
		await persistState();
		if (ctx.hasUI) {
			ctx.ui.setStatus("yo", undefined);
			ctx.ui.setStatus("igotchu", undefined);
		}
	});

	pi.registerCommand("yo", {
		description: t("command.description"),
		getArgumentCompletions: async (argumentPrefix: string): Promise<AutocompleteItem[] | null> => {
			bindI18n();
			const p = String(argumentPrefix ?? "");
			const trimmed = p.trimStart();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const head = (parts[0] ?? "").toLowerCase();
			const tail = parts.slice(1).join(" ");

			const base: AutocompleteItem[] = [
				{ value: "status", label: "status", description: t("ac.status") },
				{ value: "report", label: "report", description: t("ac.report") },
				{ value: "on", label: "on", description: t("ac.on") },
				{ value: "off", label: "off", description: t("ac.off") },
				{ value: "sync", label: "sync", description: t("ac.sync") },
				{ value: "reset", label: "reset", description: t("ac.reset") },
				{ value: "threshold ", label: "threshold", description: t("ac.threshold") },
				{ value: "nudge ", label: "nudge", description: t("ac.nudge") },
				{ value: "model ", label: "model", description: t("ac.model") },
				{ value: "deep", label: "deep", description: t("ac.deep") },
			];

			if (!trimmed) return base;

			if (head === "model") {
				const subs: AutocompleteItem[] = [
					{ value: "model show", label: "model show", description: t("ac.modelShow") },
					{ value: "model auto", label: "model auto", description: t("ac.modelAuto") },
					{ value: "model pin ", label: "model pin", description: t("ac.modelPin") },
				];
				if (!tail.trim() || tail.toLowerCase().startsWith("pin")) {
					const ctx = lastCtx;
					if (ctx && tail.toLowerCase().startsWith("pin")) {
						const models = (ctx.modelRegistry.getAvailable() as Model<Api>[]).slice(0, 40);
						const items: AutocompleteItem[] = models.map((m) => ({
							value: `model pin ${m.provider}/${m.id}`,
							label: `${m.provider}/${m.id}`,
							description: `ctx=${m.contextWindow} maxTok=${m.maxTokens}`,
						}));
						return [...subs, ...items];
					}
				}
				return subs;
			}

			if (head === "threshold") {
				return [95, 96, 97, 98, 99].map((v) => ({ value: `threshold ${v}`, label: `threshold ${v}` }));
			}
			if (head === "nudge") {
				return [70, 80, 85, 90, 95].map((v) => ({ value: `nudge ${v}`, label: `nudge ${v}` }));
			}
			return base;
		},
		handler: async (args, ctx) => {
			bindI18n();
			lastCtx = ctx;
			const input = String(args ?? "").trim();
			const [cmdRaw, ...rest] = input.split(/\s+/).filter(Boolean);
			const cmd = (cmdRaw ?? "").toLowerCase();
			const tail = rest.join(" ").trim();

			if (!cmd) {
				// /yo => quick status
				ctx.ui?.notify?.(buildStatusLine(), "info");
				setFooterStatus(ctx);
				return;
			}

			switch (cmd) {
				case "on": {
					config.enabled = true;
					await persistConfig();
					selectCheapModel(ctx, true);
					ctx.ui.notify(t("notify.enabled"), "info");
					setFooterStatus(ctx);
					return;
				}
				case "off": {
					config.enabled = false;
					clearDriftWork();
					await persistConfig();
					ctx.ui.notify(t("notify.disabled"), "warning");
					setFooterStatus(ctx);
					return;
				}
				case "status":
				case "show": {
					ctx.ui.notify(buildStatusLine(), "info");
					return;
				}
				case "report": {
					await openReport(ctx);
					return;
				}
				case "sync": {
					await syncMemory(ctx, "manual");
					return;
				}
				case "threshold": {
					const v = Number(tail);
					if (!Number.isFinite(v) || v < 95 || v > 99) {
						ctx.ui.notify(t("notify.usage.threshold"), "warning");
						return;
					}
					config.threshold = Math.round(v);
					await persistConfig();
					ctx.ui.notify(t("notify.thresholdSet", { threshold: config.threshold }), "info");
					setFooterStatus(ctx);
					return;
				}
				case "nudge": {
					const v = Number(tail);
					if (!Number.isFinite(v) || v < 0 || v > 100) {
						ctx.ui.notify(t("notify.usage.nudge"), "warning");
						return;
					}
					config.nudgeThreshold = Math.round(v);
					await persistConfig();
					ctx.ui.notify(t("notify.nudgeSet", { threshold: config.nudgeThreshold }), "info");
					setFooterStatus(ctx);
					return;
				}
				case "model": {
					const [subRaw, ...rest2] = rest;
					const sub = String(subRaw ?? "").toLowerCase();
					const modelArg = rest2.join(" ").trim();

					if (!sub || sub === "show") {
						ctx.ui.notify(
							t("notify.modelStatus", {
								model: modelRef(selectedModel ?? undefined),
								mode: config.modelMode,
								reason: selectedModelReason || t("common.na"),
							}),
							"info",
						);
						return;
					}
					if (sub === "auto") {
						config.modelMode = "auto";
						config.pinnedModel = null;
						selectCheapModel(ctx, true);
						await persistConfig();
						setFooterStatus(ctx);
						return;
					}
					if (sub === "pin") {
						const parsed = parseModelRef(modelArg);
						if (!parsed) {
							ctx.ui.notify(t("notify.usage.modelPin"), "warning");
							return;
						}
						const m = (ctx.modelRegistry.getAvailable() as Model<Api>[]).find(
							(x) => x.provider === parsed.provider && x.id === parsed.id,
						);
						if (!m) {
							ctx.ui.notify(t("notify.pinnedUnavailable"), "warning");
							return;
						}
						config.modelMode = "pinned";
						config.pinnedModel = `${parsed.provider}/${parsed.id}`;
						selectCheapModel(ctx, true);
						await persistConfig();
						setFooterStatus(ctx);
						return;
					}
					ctx.ui.notify(t("notify.usage.model"), "info");
					return;
				}
				case "deep": {
					if (!ctx.model) {
						ctx.ui.notify(t("error.noChatModelSelected"), "warning");
						return;
					}
					const mem = await ensureMemoryLoaded(ctx);
					const result = await ctx.ui.custom<DriftVerdict | null>((tui, theme, _kb, done) => {
						const loader = new BorderedLoader(tui, theme, t("deep.loader"));
						loader.onAbort = () => done(null);
						void (async () => {
							try {
								done(await runDeepVerdict(ctx, mem.text, loader.signal));
							} catch (err) {
								const rawMsg = err instanceof Error ? err.message : String(err);
								const msg = rawMsg.startsWith("error.") ? t(rawMsg) : rawMsg;
								ctx.ui.notify(msg, "error");
								done(null);
							}
						})();
						return loader;
					});
					if (!result) return;

					lastDrift = result.drift;
					lastConfidence = result.confidence;
					lastNudge = result.nudge;
					lastReason = result.reason;
					lastAdvice = result.advice ?? null;

					pushRow({
						ts: nowIso(),
						mode: "deep",
						model: modelRef(ctx.model as Model<Api>),
						drift: result.drift,
						confidence: result.confidence,
						nudge: result.nudge,
						reason: result.reason,
						shown: false,
					});
					await persistState();
					setFooterStatus(ctx);
					maybeNudge(ctx, result, "deep");
					await openReport(ctx);
					return;
				}
				case "reset": {
					const ok = await ctx.ui.confirm(t("confirm.reset.title"), t("confirm.reset.body"));
					if (!ok) return;
					state = defaultState();
					lastDrift = 0;
					lastConfidence = 0;
					lastNudge = "none";
					lastReason = null;
					lastAdvice = null;
					lastError = null;
					await persistState();
					await syncMemory(ctx, "reset");
					ctx.ui.notify(t("notify.resetComplete"), "info");
					setFooterStatus(ctx);
					return;
				}
				default: {
					ctx.ui.notify(t("usage"), "info");
					return;
				}
			}
		},
	});
}
