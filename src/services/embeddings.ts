/** Fallback when the config has no `embed` role. */
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function findBestMatches<T extends { embedding: Float32Array }>(
  query: Float32Array,
  candidates: T[],
  topK: number,
): (T & { score: number })[] {
  return candidates
    .map(c => ({ ...c, score: cosineSimilarity(query, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Generate an embedding vector.
 *
 * `endpoint` is a full base URL so the caller decides which provider answers —
 * hardcoding OpenRouter here meant embeddings broke the moment anything else
 * was configured. `model` is the provider's own id for its embedding model.
 */
export async function generateEmbedding(
  text: string,
  opts: { baseUrl: string; apiKey: string; model: string },
): Promise<Float32Array> {
  const response = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Embedding API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
  if (!json.data?.[0]?.embedding) throw new Error("Embedding API returned no vector");
  return new Float32Array(json.data[0].embedding);
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
