// Тонкий клиент OpenRouter. Никаких фреймворков: один POST и разбор ответа.

import { config } from './config.ts'

export interface ChatMessageContentText { type: 'text'; text: string }
export interface ChatMessageContentImage { type: 'image_url'; image_url: { url: string } }
export type ChatMessageContent = ChatMessageContentText | ChatMessageContentImage

export interface ChatMessage {
  role: 'system' | 'user'
  content: string | ChatMessageContent[]
}

export interface ChatResult {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  provider: string   // фактический провайдер ответа, для сверки прогонов
}

export async function chat(params: {
  model: string
  messages: ChatMessage[]
  temperature: number
  seed: number
}): Promise<ChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('нет OPENROUTER_API_KEY, положи ключ в .env (образец в .env.example)')
  if (params.model.startsWith('REPLACE_WITH')) {
    throw new Error('слаг модели не задан, выстави LOCI_MODEL в .env')
  }

  const startedAt = performance.now()
  const response = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      seed: params.seed,
      provider: {
        order: [...config.provider.order],
        allow_fallbacks: config.provider.allowFallbacks,
        quantizations: [...config.provider.quantizations],
      },
    }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 500)}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    provider?: string
    error?: { message?: string }
  }
  if (payload.error) throw new Error(`OpenRouter: ${payload.error.message ?? 'неизвестная ошибка'}`)

  const text = payload.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('OpenRouter вернул ответ без content')

  return {
    text,
    tokensIn: payload.usage?.prompt_tokens ?? 0,
    tokensOut: payload.usage?.completion_tokens ?? 0,
    latencyMs: Math.round(performance.now() - startedAt),
    provider: payload.provider ?? 'unknown',
  }
}

// Модели любят обрамлять JSON текстом и ```-заборами. Достаём первый объект.
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`в ответе нет JSON: ${text.slice(0, 300)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}
