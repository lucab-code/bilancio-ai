import { getAiProvider } from "./config";

type JsonSchema = Record<string, unknown>;

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

type ToolDefinition = Record<string, unknown>;

type AiProvider = "openai" | "anthropic";

const DEFAULT_OPENAI_TIMEOUT_MS = 300000;
const OPENAI_RESPONSES_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.OPENAI_RESPONSES_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_OPENAI_TIMEOUT_MS;
})();

const DEFAULT_ANTHROPIC_TIMEOUT_MS = 300000;
const ANTHROPIC_MESSAGES_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.ANTHROPIC_MESSAGES_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_ANTHROPIC_TIMEOUT_MS;
})();

interface StructuredResponseParams {
  apiKey: string;
  model: string;
  instructions: string;
  input: unknown;
  schemaName: string;
  schema: JsonSchema;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  tools?: ToolDefinition[];
  include?: string[];
  toolChoice?: "auto" | "required" | "none";
}

interface TextResponseParams {
  apiKey: string;
  model: string;
  instructions: string;
  input: unknown;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  tools?: ToolDefinition[];
  include?: string[];
  toolChoice?: "auto" | "required" | "none";
}

interface ResponsesApiOutputText {
  type: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    url_citation?: {
      title?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    };
  }>;
}

interface ResponsesApiOutputItem {
  type: string;
  content?: ResponsesApiOutputText[];
  action?: {
    sources?: Array<{
      title?: string;
      url?: string;
    }>;
  };
}

interface ResponsesApiResponse {
  status?: string;
  incomplete_details?: {
    reason?: string | null;
  } | null;
  output?: ResponsesApiOutputItem[];
}

interface AnthropicTextCitation {
  type?: string;
  url?: string;
  title?: string;
  document_title?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  citations?: AnthropicTextCitation[];
}

interface AnthropicMessageResponse {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  stop_reason?: string | null;
  content?: AnthropicContentBlock[];
}

export class OpenAIResponsesError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(extractProviderErrorMessage(body) ?? `LLM request failed with status ${status}`);
    this.name = "OpenAIResponsesError";
    this.status = status;
    this.body = body;
  }
}

function extractProviderErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.error?.details || parsed?.message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
  } catch {
    return body.trim() ? body.trim().slice(0, 400) : null;
  }
}

function inferProviderFromModel(model: string): AiProvider | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gpt-") || normalized.startsWith("o")) return "openai";
  return null;
}

function resolveProvider(model: string): AiProvider {
  return inferProviderFromModel(model) || getAiProvider();
}

function getOutputText(response: ResponsesApiResponse): string {
  const chunks: string[] = [];

  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function getOutputSources(response: ResponsesApiResponse): Array<{ title: string; url: string }> {
  const deduped = new Map<string, { title: string; url: string }>();

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        for (const annotation of content.annotations ?? []) {
          const title = annotation?.url_citation?.title || annotation?.title;
          const url = annotation?.url_citation?.url || annotation?.url;
          if (typeof url === "string" && url.trim()) {
            deduped.set(url, {
              title: typeof title === "string" && title.trim() ? title.trim() : url,
              url,
            });
          }
        }
      }
    }

    const actionSources = Array.isArray(item.action?.sources) ? item.action.sources : [];
    for (const source of actionSources) {
      const url = typeof source?.url === "string" ? source.url.trim() : "";
      const title = typeof source?.title === "string" ? source.title.trim() : "";
      if (!url) continue;
      deduped.set(url, { title: title || url, url });
    }
  }

  return Array.from(deduped.values());
}

function getAnthropicOutputText(response: AnthropicMessageResponse): string {
  return (response.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getAnthropicOutputSources(response: AnthropicMessageResponse): Array<{ title: string; url: string }> {
  const deduped = new Map<string, { title: string; url: string }>();

  for (const block of response.content || []) {
    for (const citation of block.citations || []) {
      const url = typeof citation?.url === "string" ? citation.url.trim() : "";
      if (!url) continue;
      const title =
        typeof citation?.title === "string" && citation.title.trim()
          ? citation.title.trim()
          : typeof citation?.document_title === "string" && citation.document_title.trim()
            ? citation.document_title.trim()
            : url;
      deduped.set(url, { title, url });
    }
  }

  return Array.from(deduped.values());
}

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

async function fetchOpenAIResponses(apiKey: string, payload: Record<string, unknown>): Promise<ResponsesApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_RESPONSES_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new OpenAIResponsesError(response.status, bodyText);
    }

    try {
      const parsed = JSON.parse(bodyText) as ResponsesApiResponse;
      const hasText = (parsed.output ?? []).some(
        (item) => item.type === "message" && (item.content ?? []).some((c) => c.type === "output_text" && c.text),
      );
      if (!hasText) {
        console.warn("[OpenAI debug] Response has no output_text. status:", parsed.status, "output types:", JSON.stringify((parsed.output ?? []).map((o) => ({ type: o.type, contentTypes: (o.content ?? []).map((c) => c.type) }))));
        if ((parsed.output ?? []).length > 0) {
          console.warn("[OpenAI debug] First output item:", JSON.stringify(parsed.output![0]).slice(0, 500));
        }
      }
      return parsed;
    } catch {
      throw new Error("La risposta OpenAI non era JSON valido");
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`OpenAI timeout dopo ${Math.round(OPENAI_RESPONSES_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractBase64Payload(dataUri: string): { mimeType: string; data: string } | null {
  const match = dataUri.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function normalizeAnthropicContentBlock(block: any): Array<Record<string, unknown>> {
  if (!block || typeof block !== "object") return [];

  if (block.type === "input_text" && typeof block.text === "string") {
    return [{ type: "text", text: block.text }];
  }

  if (block.type === "input_file" && typeof block.file_data === "string") {
    const parsed = extractBase64Payload(block.file_data);
    if (!parsed) {
      return typeof block.filename === "string" ? [{ type: "text", text: `Allegato: ${block.filename}` }] : [];
    }

    if (parsed.mimeType === "application/pdf") {
      return [{
        type: "document",
        source: {
          type: "base64",
          media_type: parsed.mimeType,
          data: parsed.data,
        },
        title: typeof block.filename === "string" ? block.filename : undefined,
      }];
    }

    if (parsed.mimeType.startsWith("image/")) {
      return [{
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mimeType,
          data: parsed.data,
        },
      }];
    }

    return typeof block.filename === "string" ? [{ type: "text", text: `Allegato: ${block.filename}` }] : [];
  }

  if (typeof block.text === "string" && block.text.trim()) {
    return [{ type: "text", text: block.text.trim() }];
  }

  return [];
}

function normalizeAnthropicMessages(input: unknown): Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: [{ type: "text", text: JSON.stringify(input, null, 2) }] }];
  }

  const messages = input
    .map((message: any) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = Array.isArray(message?.content)
        ? message.content.flatMap((block: any) => normalizeAnthropicContentBlock(block))
        : typeof message?.content === "string"
          ? [{ type: "text", text: message.content }]
          : [];

      if (content.length === 0) return null;
      return { role, content };
    })
    .filter((message): message is { role: "user" | "assistant"; content: Array<Record<string, unknown>> } => Boolean(message));

  return messages.length > 0
    ? messages
    : [{ role: "user", content: [{ type: "text", text: JSON.stringify(input, null, 2) }] }];
}

function mapAnthropicBuiltInTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  return tools.flatMap((tool) => {
    if (tool?.type !== "web_search") return [];
    const userLocation = typeof tool.user_location === "object" && tool.user_location ? tool.user_location : undefined;
    return [{
      type: "web_search_20250305",
      name: "web_search",
      ...(userLocation ? { user_location: userLocation } : {}),
    }];
  });
}

function mapAnthropicReasoning(reasoningEffort: ReasoningEffort, maxTokens: number): Record<string, unknown> | undefined {
  if (reasoningEffort === "minimal" || reasoningEffort === "low") return undefined;
  const desiredBudget = reasoningEffort === "high" ? 4096 : 2048;
  const maxAllowedBudget = Math.max(0, maxTokens - 512);
  if (maxAllowedBudget < 1024) return undefined;
  return {
    type: "enabled",
    budget_tokens: Math.min(desiredBudget, maxAllowedBudget),
  };
}

function buildAnthropicHeaders(apiKey: string, tools: Array<Record<string, unknown>>): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  if (tools.some((tool) => tool.type === "web_search_20250305")) {
    headers["anthropic-beta"] = "web-search-2025-03-05";
  }

  return headers;
}

async function fetchAnthropicMessage(
  apiKey: string,
  payload: Record<string, unknown>,
  tools: Array<Record<string, unknown>>,
): Promise<AnthropicMessageResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MESSAGES_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: buildAnthropicHeaders(apiKey, tools),
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new OpenAIResponsesError(response.status, bodyText);
    }

    try {
      return JSON.parse(bodyText) as AnthropicMessageResponse;
    } catch {
      throw new Error("La risposta Anthropic non era JSON valido");
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Anthropic timeout dopo ${Math.round(ANTHROPIC_MESSAGES_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runAnthropicConversation(
  apiKey: string,
  payload: Record<string, unknown>,
  tools: Array<Record<string, unknown>>,
): Promise<AnthropicMessageResponse> {
  let currentMessages = Array.isArray(payload.messages) ? [...payload.messages as Array<any>] : [];

  for (let turn = 0; turn < 3; turn++) {
    const response = await fetchAnthropicMessage(apiKey, { ...payload, messages: currentMessages }, tools);
    if (response.stop_reason !== "pause_turn") {
      return response;
    }

    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: response.content || [],
      },
    ];
  }

  throw new Error("Anthropic non ha completato il turno di web search");
}

async function createOpenAIStructuredResponse<T>({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens,
  reasoningEffort = "low",
  tools,
  include,
  toolChoice,
}: StructuredResponseParams): Promise<T> {
  let currentMaxOutputTokens = maxOutputTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    const parsedResponse = await fetchOpenAIResponses(apiKey, {
      model,
      instructions,
      input,
      reasoning: { effort: reasoningEffort },
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema,
          strict: true,
        },
      },
      max_output_tokens: currentMaxOutputTokens,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      ...(Array.isArray(include) && include.length > 0 ? { include } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });

    if (
      parsedResponse.status === "incomplete" &&
      parsedResponse.incomplete_details?.reason === "max_output_tokens" &&
      attempt === 0
    ) {
      currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 16000);
      continue;
    }

    const outputText = getOutputText(parsedResponse);
    if (!outputText) {
      throw new Error("La risposta OpenAI non contiene testo utilizzabile");
    }

    try {
      return JSON.parse(outputText) as T;
    } catch {
      if (
        parsedResponse.status === "incomplete" &&
        parsedResponse.incomplete_details?.reason === "max_output_tokens" &&
        attempt === 0
      ) {
        currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 16000);
        continue;
      }
      throw new Error("La risposta OpenAI non rispetta il JSON richiesto");
    }
  }

  throw new Error("La risposta OpenAI e' stata troncata per limite di output");
}

async function createOpenAITextResponse({
  apiKey,
  model,
  instructions,
  input,
  maxOutputTokens,
  reasoningEffort = "low",
  tools,
  include,
  toolChoice,
}: TextResponseParams): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  const parsedResponse = await fetchOpenAIResponses(apiKey, {
    model,
    instructions,
    input,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: maxOutputTokens,
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(Array.isArray(include) && include.length > 0 ? { include } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  });

  const text = getOutputText(parsedResponse);
  if (!text) {
    throw new Error("La risposta OpenAI non contiene testo utilizzabile");
  }

  return {
    text,
    sources: getOutputSources(parsedResponse),
  };
}

async function createAnthropicStructuredResponse<T>({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens,
  reasoningEffort = "low",
  tools,
  toolChoice,
}: StructuredResponseParams): Promise<T> {
  let currentMaxOutputTokens = maxOutputTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    const builtInTools = mapAnthropicBuiltInTools(tools);
    const anthropicTools = [
      ...builtInTools,
      {
        name: schemaName,
        description: `Restituisci la risposta finale come JSON valido per lo schema ${schemaName}.`,
        input_schema: schema,
      },
    ];

    const thinking =
      builtInTools.length === 0 && toolChoice !== "none"
        ? undefined
        : mapAnthropicReasoning(reasoningEffort, currentMaxOutputTokens);
    const response = await runAnthropicConversation(
      apiKey,
      {
        model,
        system: `${instructions}\n\nDevi restituire il risultato finale chiamando il tool "${schemaName}" una sola volta con il JSON completo.`,
        messages: normalizeAnthropicMessages(input),
        max_tokens: currentMaxOutputTokens,
        tools: anthropicTools,
        tool_choice:
          builtInTools.length === 0 && toolChoice !== "none"
            ? { type: "tool", name: schemaName }
            : toolChoice === "none"
              ? { type: "none" }
              : { type: "auto" },
        ...(thinking ? { thinking } : {}),
      },
      anthropicTools,
    );

    const toolUseBlock = (response.content || []).find(
      (block) => block.type === "tool_use" && block.name === schemaName,
    );
    if (toolUseBlock?.input) {
      return toolUseBlock.input as T;
    }

    const text = getAnthropicOutputText(response);
    if (!text) {
      throw new Error("La risposta Anthropic non contiene output strutturato");
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      if (response.stop_reason === "max_tokens" && attempt === 0) {
        currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 16000);
        continue;
      }
      throw new Error("La risposta Anthropic non rispetta il JSON richiesto");
    }
  }

  throw new Error("La risposta Anthropic e' stata troncata per limite di output");
}

async function createAnthropicTextResponse({
  apiKey,
  model,
  instructions,
  input,
  maxOutputTokens,
  reasoningEffort = "low",
  tools,
  toolChoice,
}: TextResponseParams): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  const anthropicTools = mapAnthropicBuiltInTools(tools);
  const thinking = mapAnthropicReasoning(reasoningEffort, maxOutputTokens);
  const response = await runAnthropicConversation(
    apiKey,
    {
      model,
      system: instructions,
      messages: normalizeAnthropicMessages(input),
      max_tokens: maxOutputTokens,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(anthropicTools.length > 0
        ? {
            tool_choice:
              toolChoice === "none"
                ? { type: "none" }
                : { type: "auto" },
          }
        : {}),
      ...(thinking ? { thinking } : {}),
    },
    anthropicTools,
  );

  const text = getAnthropicOutputText(response);
  if (!text) {
    throw new Error("La risposta Anthropic non contiene testo utilizzabile");
  }

  return {
    text,
    sources: getAnthropicOutputSources(response),
  };
}

export async function createStructuredResponse<T>(params: StructuredResponseParams): Promise<T> {
  return resolveProvider(params.model) === "anthropic"
    ? createAnthropicStructuredResponse<T>(params)
    : createOpenAIStructuredResponse<T>(params);
}

export async function createTextResponse(
  params: TextResponseParams,
): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  return resolveProvider(params.model) === "anthropic"
    ? createAnthropicTextResponse(params)
    : createOpenAITextResponse(params);
}
