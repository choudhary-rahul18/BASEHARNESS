import Anthropic from '@anthropic-ai/sdk';
import { toolSchemas } from './tools.js';

// ── Shared types ──────────────────────────────────────────────────────────────
// PageObservation: what the harness sees at each step — fed into every adapter.
// ActionResult: what the adapter returns — the same shape regardless of provider.
// The supervisor loop only ever works with these two types.

export interface PageObservation {
  url: string;
  title: string;
  tree: string;
}

export interface ActionResult {
  toolName: string;                    // empty string if the LLM returned no tool call
  toolInput: Record<string, unknown>;
  reasoning: string;                   // any text the LLM produced alongside the tool call
}

// ── Adapter interface ─────────────────────────────────────────────────────────
// This is the only contract the supervisor loop knows about.
// Each adapter implements it using its own protocol internally.
export interface LLMAdapter {
  getNextAction(obs: PageObservation): Promise<ActionResult>;
}

// ── Anthropic Adapter ─────────────────────────────────────────────────────────
// Owns the Anthropic-specific details:
//   • message history in Anthropic format
//   • tool_use / tool_result ID pairing
//   • response parsing (content blocks)
class AnthropicAdapter implements LLMAdapter {
  private client = new Anthropic();
  private messages: Anthropic.MessageParam[] = [];
  private lastToolCallId: string | null = null; // tracked internally — loop never sees this

  constructor(private systemPrompt: string) {}

  async getNextAction(obs: PageObservation): Promise<ActionResult> {
    const observationText =
      `Current URL: ${obs.url}\n` +
      `Page title: ${obs.title}\n\n` +
      `Interactive elements on the page:\n${obs.tree}`;

    // Anthropic protocol: tool_result must immediately follow tool_use.
    // The adapter handles this internally — the loop just passes observations.
    if (this.lastToolCallId) {
      this.messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: this.lastToolCallId, content: 'Action executed successfully.' },
          { type: 'text', text: observationText },
        ],
      });
    } else {
      this.messages.push({ role: 'user', content: observationText });
    }

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: this.systemPrompt,
      messages: this.messages,
      tools: toolSchemas,
    });

    this.messages.push({ role: 'assistant', content: response.content });

    let reasoning = '';
    let toolBlock: Anthropic.ToolUseBlock | null = null;

    for (const block of response.content) {
      if (block.type === 'text')     reasoning  = block.text;
      if (block.type === 'tool_use') toolBlock  = block;
    }

    // Store the ID so we can close the pair on the next call.
    this.lastToolCallId = toolBlock?.id ?? null;

    return {
      toolName:  toolBlock?.name  ?? '',
      toolInput: (toolBlock?.input ?? {}) as Record<string, unknown>,
      reasoning,
    };
  }
}

// ── Ollama Adapter ────────────────────────────────────────────────────────────
// Owns the Ollama-specific details:
//   • message history in Ollama/OpenAI format (system message in array, tool role)
//   • tool schema translation (Anthropic → OpenAI format)
//   • response parsing (message.tool_calls array, not content blocks)
//   • no ID pairing needed — Ollama tool results don't require matching IDs

// Ollama message shape — different from Anthropic's MessageParam.
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

// Translate Anthropic tool schema format → Ollama/OpenAI tool format.
// Anthropic: { name, description, input_schema: { type, properties, required } }
// Ollama:    { type: 'function', function: { name, description, parameters: {...} } }
function toOllamaTools(schemas: Anthropic.Tool[]) {
  return schemas.map(s => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description ?? '',
      parameters: s.input_schema,
    },
  }));
}

class OllamaAdapter implements LLMAdapter {
  private messages: OllamaMessage[] = [];
  private tools = toOllamaTools(toolSchemas);
  private hadPreviousToolCall = false;

  constructor(systemPrompt: string) {
    // Ollama takes the system prompt as a message in the array, not a separate field.
    this.messages.push({ role: 'system', content: systemPrompt });
  }

  async getNextAction(obs: PageObservation): Promise<ActionResult> {
    const observationText =
      `Current URL: ${obs.url}\n` +
      `Page title: ${obs.title}\n\n` +
      `Interactive elements on the page:\n${obs.tree}`;

    // Ollama tool result: a separate 'tool' role message (no ID required).
    if (this.hadPreviousToolCall) {
      this.messages.push({ role: 'tool', content: 'Action executed successfully.' });
    }
    this.messages.push({ role: 'user', content: observationText });

    const response = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'ministral-3:3b',
        messages: this.messages,
        tools: this.tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${body}`);
    }

    // Ollama response shape: { message: { role, content, tool_calls? } }
    const data = await response.json() as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
    };

    const msg = data.message;
    this.messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    const toolCall = msg.tool_calls?.[0];
    this.hadPreviousToolCall = !!toolCall;

    return {
      toolName:  toolCall?.function.name      ?? '',
      toolInput: toolCall?.function.arguments ?? {},
      reasoning: msg.content ?? '',
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
// The only thing the supervisor loop imports. Pass a provider string, get back
// an adapter. Adding a new provider = adding one new class + one line here.
export type Provider = 'anthropic' | 'ollama';

export function createAdapter(provider: Provider, systemPrompt: string): LLMAdapter {
  if (provider === 'anthropic') return new AnthropicAdapter(systemPrompt);
  if (provider === 'ollama')    return new OllamaAdapter(systemPrompt);
  throw new Error(`Unknown LLM provider: "${provider}"`);
}
