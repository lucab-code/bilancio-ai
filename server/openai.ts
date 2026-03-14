type JsonSchema = Record<string, unknown>;

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

type ToolDefinition = Record<string, unknown>;

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

export class OpenAIResponsesError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(extractOpenAIErrorMessage(body) ?? `OpenAI request failed with status ${status}`);
    this.name = "OpenAIResponsesError";
    this.status = status;
    this.body = body;
  }
}

function extractOpenAIErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
  } catch {
    return body.trim() ? body.trim().slice(0, 400) : null;
  }
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
          const title =
            annotation?.url_citation?.title ||
            annotation?.title;
          const url =
            annotation?.url_citation?.url ||
            annotation?.url;
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

export async function createStructuredResponse<T>({
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
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new OpenAIResponsesError(response.status, bodyText);
    }

    let parsedResponse: ResponsesApiResponse;
    try {
      parsedResponse = JSON.parse(bodyText) as ResponsesApiResponse;
    } catch {
      throw new Error("La risposta OpenAI non era JSON valido");
    }

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

export async function createTextResponse({
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
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      ...(Array.isArray(include) && include.length > 0 ? { include } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new OpenAIResponsesError(response.status, bodyText);
  }

  let parsedResponse: ResponsesApiResponse;
  try {
    parsedResponse = JSON.parse(bodyText) as ResponsesApiResponse;
  } catch {
    throw new Error("La risposta OpenAI non era JSON valido");
  }

  const text = getOutputText(parsedResponse);
  if (!text) {
    throw new Error("La risposta OpenAI non contiene testo utilizzabile");
  }

  return {
    text,
    sources: getOutputSources(parsedResponse),
  };
}
