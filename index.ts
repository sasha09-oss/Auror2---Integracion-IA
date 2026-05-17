/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AUROR RESEARCH WORKER v2  ·  Cloudflare Workers · Edge AI Orchestration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Platform:  Cloudflare Workers (V8 Isolate, NO Node.js APIs)
 *  Flow:     User input (text/document) → JS webapp → JSON → Worker → JSON/txt
 *  Tasks:    process | social_search | semantic_matcher | data_extractor | chat_with_media
 *  Models:   Workers AI (glm-4.7-flash, qwen3-embedding, llama-3.2-11b-vision)
 *
 *  OUTPUT FORMAT controlled by `output_format` field:
 *    "json"  → structured data only (default)
 *    "txt"   → human-readable plain text (via glm-4.7-flash normalization)
 *    "both"  → both json data + txt_output in the same response
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

interface Env {
  AI: Ai;
  API_KEY: string;
  ALLOWED_ORIGINS: string;
  SERPER_API_KEY: string;
  CRAWLBASE_TOKEN: string;
  CRAWLBASE_JS_TOKEN: string;
  APYHUB_TOKEN: string;
  SCRAPINGBEE_API_KEY: string;
  ENVIRONMENT: string;
  MAX_DOCUMENTS_SEMANTIC: string;
  MAX_RESULTS_SOCIAL: string;
  DEFAULT_SEARCH_PLATFORMS: string;
}

/** Standard success envelope — includes optional text_output for .txt downloads */
interface AurorSuccessResponse {
  success: true;
  data: unknown;
  /** Populated when output_format is "txt" or "both" */
  text_output?: string;
  meta: {
    request_id: string;
    timestamp: string;
    model_used: string;
    latency_ms: number;
    output_format: "json" | "txt" | "both";
    attempts?: number;
  };
}

/** Standard error envelope */
interface AurorErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    request_id: string;
    timestamp: string;
  };
}

type AurorResponse = AurorSuccessResponse | AurorErrorResponse;

// ─── Output Format ───────────────────────────────────────────────────────────

type OutputFormat = "json" | "txt" | "both";

// ─── Task Payload Types ─────────────────────────────────────────────────────

/**
 * NEW TASK: process
 * Generic text/document input. The webapp JS packages user input here.
 * The Worker auto-routes to the right AI pipeline based on input_type.
 */
interface ProcessPayload {
  /** What the user provided */
  input_type: "text" | "document_base64" | "image_base64";
  /** The actual content: plain text or base64 string */
  content: string;
  /** MIME type for documents/images (e.g. "application/pdf", "image/png") */
  mime_type?: string;
  /** Original filename (for metadata) */
  filename?: string;
  /** What the user wants done — free-form instruction from the user */
  instructions: string;
  /** Suggested processing mode the webapp selects based on UI flow */
  mode: "analyze" | "summarize" | "extract" | "compare" | "search" | "translate";
}

interface SocialSearchPayload {
  query: string;
  platforms: string[];
  max_results: number;
  /** Optional secondary scraper to run alongside Serper.dev for deeper results */
  secondary_scraper?: "crawlbase" | "apyhub" | "scrapingbee";
}

interface SemanticMatcherPayload {
  documents: Array<{ id: string; content: string }>;
}

interface DataExtractorPayload {
  type: "url" | "image_base64" | "document_base64";
  source: string;
  extract_mode: "metadata" | "text" | "structured";
  /** MIME type when type=document_base64 */
  mime_type?: string;
  filename?: string;
}

interface ChatWithMediaPayload {
  images: Array<{ base64: string; name: string }>;
  prompt: string;
  context_mode: "qa" | "summarize" | "extract";
}

interface TaskRequest {
  task: string;
  payload: unknown;
  /** Output format: "json" (default), "txt" (plain text), "both" (JSON + txt) */
  output_format?: OutputFormat;
  /** Optional user context / conversation ID for the webapp */
  context_id?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_TASKS = new Set([
  "process",
  "social_search",
  "semantic_matcher",
  "data_extractor",
  "chat_with_media",
]);

const VALID_OUTPUT_FORMATS = new Set(["json", "txt", "both"]);

const SUPPORTED_PLATFORMS = new Set([
  "linkedin",
  "twitter",
  "github",
  "instagram",
  "facebook",
  "youtube",
  "reddit",
  "medium",
  "dev.to",
  "x.com",
]);

const MODELS = {
  chat: "@cf/zai-org/glm-4.7-flash",
  embedding: "@cf/qwen/qwen3-embedding-0.6b",
  vision: "@cf/meta/llama-3.2-11b-vision-instruct",
} as const;

const TIMEOUT_MS = 30_000;

/** 20 MB in base64 ≈ 27 MB — Cloudflare Workers free plan allows 100 MB body */
const MAX_BASE64_LENGTH = 27_000_000;

/** Max plain text content length */
const MAX_TEXT_LENGTH = 500_000;

// ─── Utility Functions ───────────────────────────────────────────────────────

function generateRequestId(): string {
  const segment = () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
  return `arw-${Date.now().toString(36)}-${segment()}${segment()}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function latency(start: number): number {
  return Date.now() - start;
}

/** Minimal string validation */
function isNonEmptyString(v: unknown, min = 1, max = 10000): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Detect if a base64 string looks like an image (JPEG/PNG/GIF/WebP) */
function isImageMimeType(mime?: string): boolean {
  if (!mime) return false;
  return mime.startsWith("image/");
}

/** Supported document MIME types that the Worker can handle via vision model */
function isDocumentMimeType(mime?: string): boolean {
  if (!mime) return false;
  return [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
    "text/html",
    "text/markdown",
  ].includes(mime);
}

// ─── CORS & Auth Helpers ────────────────────────────────────────────────────

function getAllowedOrigin(requestOrigin: string | null, env: Env): string | null {
  if (!requestOrigin) return null;
  const allowed = env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? [];
  if (allowed.includes("*")) return requestOrigin;
  const match = allowed.find((o) => o.toLowerCase() === requestOrigin.toLowerCase());
  return match ?? null;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowedOrigin = origin ? getAllowedOrigin(origin, env) : null;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function authenticate(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (!env.API_KEY) return false;
  return token === env.API_KEY;
}

// ─── Response Builders ──────────────────────────────────────────────────────

function success(
  data: unknown,
  requestId: string,
  modelUsed: string,
  startTime: number,
  outputFormat: OutputFormat = "json",
  attempts?: number,
  textOutput?: string
): AurorSuccessResponse {
  return {
    success: true,
    data,
    ...(textOutput ? { text_output: textOutput } : {}),
    meta: {
      request_id: requestId,
      timestamp: nowISO(),
      model_used: modelUsed,
      latency_ms: latency(startTime),
      output_format: outputFormat,
      ...(attempts !== undefined ? { attempts } : {}),
    },
  };
}

function error(
  code: string,
  message: string,
  requestId: string,
  details?: unknown
): AurorErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    meta: {
      request_id: requestId,
      timestamp: nowISO(),
    },
  };
}

// ─── Output Normalization via glm-4.7-flash ──────────────────────────────────

/**
 * Takes raw task output data and normalizes it to a human-readable plain text
 * format using glm-4.7-flash. This is the key step that produces the .txt
 * downloadable output for the Auror webapp.
 */
async function normalizeToText(
  ai: Ai,
  task: string,
  data: unknown,
  instructions?: string
): Promise<string> {
  const taskDescriptions: Record<string, string> = {
    process: "User input processing",
    social_search: "Social media profile search",
    semantic_matcher: "Semantic document comparison",
    data_extractor: "Data extraction from URL or image",
    chat_with_media: "Image/document conversation",
  };

  const prompt = `You are an output formatter for the Auror platform. Convert the following structured data into a clean, well-organized plain text report that a user can read and download as a .txt file.

Task performed: ${taskDescriptions[task] ?? task}
${instructions ? `User instructions: ${instructions}` : ""}

Raw data:
${JSON.stringify(data, null, 2)}

Rules:
- Write in clear, professional language
- Use headers (ALL CAPS) to separate sections
- Use bullet points with "•" for lists
- Include all important data — do not omit information
- Do NOT wrap output in code fences or markdown
- Output plain text only, ready for .txt download
- If the data contains profiles, list them with name, platform, URL, and confidence
- If the data contains similarity scores, present them in a readable table format
- If the data contains extracted text, include it verbatim in a clearly marked section`;

  try {
    const result = await runChat(ai, [
      { role: "system", content: "You produce clean, well-formatted plain text reports. No markdown, no code fences, no HTML." },
      { role: "user", content: prompt },
    ]);
    return result || "Normalization produced empty output.";
  } catch {
    // Fallback: pretty-print the raw JSON as text
    return `=== Auror Output ===\nTask: ${task}\n\n${JSON.stringify(data, null, 2)}`;
  }
}

/**
 * Apply output formatting based on the requested output_format.
 * - "json": return data as-is
 * - "txt": normalize to text, put in text_output, data is minimal summary
 * - "both": keep data + add text_output
 */
async function applyOutputFormat(
  ai: Ai,
  task: string,
  data: unknown,
  outputFormat: OutputFormat,
  requestId: string,
  modelUsed: string,
  startTime: number,
  attempts?: number,
  instructions?: string
): Promise<AurorSuccessResponse> {
  if (outputFormat === "json") {
    return success(data, requestId, modelUsed, startTime, "json", attempts);
  }

  // Normalize to text for "txt" or "both"
  const textOutput = await normalizeToText(ai, task, data, instructions);

  if (outputFormat === "txt") {
    return success(
      { summary: `Output for task "${task}" — see text_output field for downloadable content` },
      requestId,
      `${modelUsed}+normalizer`,
      startTime,
      "txt",
      attempts,
      textOutput
    );
  }

  // "both"
  return success(
    data,
    requestId,
    `${modelUsed}+normalizer`,
    startTime,
    "both",
    attempts,
    textOutput
  );
}

// ─── Scraping & Search APIs ────────────────────────────────────────────────
//
//  Stack: Serper.dev (main search) → Crawlbase → Apyhub → ScrapingBee (fallback)
//  Secondary: User can pick a scraper to run alongside Serper for deeper results.

// ── 1. Serper.dev (Main Search API) ────────────────────────────────────────

interface SerperSearchResult {
  title: string;
  link: string;
  snippet?: string;
}

interface SerperSearchResponse {
  organic?: Array<SerperSearchResult>;
  searchParameters?: { q?: string };
}

async function searchSerper(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<{ results: SerperSearchResult[]; used: "serper" }> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      num: Math.min(maxResults, 100),
      gl: "us",
      hl: "en",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Serper API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as SerperSearchResponse;
  const results = data?.organic ?? [];
  return { results, used: "serper" as const };
}

// ── 2. Crawlbase (Scraping API) ────────────────────────────────────────────
//  Regular token for static pages, JS token for JS-rendered pages (LinkedIn, Twitter)

interface ScrapedContent {
  url: string;
  content: string;
  used: "crawlbase" | "apyhub" | "scrapingbee";
}

async function scrapeCrawlbase(
  url: string,
  token: string,
  jsToken: string,
  useJs: boolean
): Promise<ScrapedContent> {
  const tokenToUse = useJs ? jsToken : token;
  const apiUrl = `https://api.crawlbase.com/?token=${encodeURIComponent(tokenToUse)}&url=${encodeURIComponent(url)}`;
  const response = await fetch(apiUrl, {
    method: "GET",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Crawlbase API ${response.status}: ${body.slice(0, 200)}`);
  }

  const content = await response.text();
  return { url, content, used: "crawlbase" };
}

// ── 3. Apyhub (Scraping API) ───────────────────────────────────────────────

async function scrapeApyhub(
  url: string,
  token: string
): Promise<ScrapedContent> {
  const apiUrl = `https://api.apyhub.com/sharpapi/api/v1/utilities/scrape_url/?url=${encodeURIComponent(url)}`;
  const response = await fetch(apiUrl, {
    method: "GET",
    headers: {
      "apy-token": token,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Apyhub API ${response.status}: ${body.slice(0, 200)}`);
  }

  const content = await response.text();
  return { url, content, used: "apyhub" };
}

// ── 4. ScrapingBee (Scraping API) ──────────────────────────────────────────

async function scrapeScrapingBee(
  url: string,
  apiKey: string
): Promise<ScrapedContent> {
  const apiUrl = `https://app.scrapingbee.com/api/v1?api_key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(url)}`;
  const response = await fetch(apiUrl, {
    method: "GET",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ScrapingBee API ${response.status}: ${body.slice(0, 200)}`);
  }

  const content = await response.text();
  return { url, content, used: "scrapingbee" };
}

// ── Unified Fallback Scraper ───────────────────────────────────────────────
//  Tries Crawlbase → Apyhub → ScrapingBee in order until one succeeds.

async function scrapeWithFallback(
  url: string,
  env: Env,
  useJs: boolean
): Promise<ScrapedContent> {
  const errors: Array<{ api: string; message: string }> = [];

  // Try Crawlbase
  try {
    return await scrapeCrawlbase(url, env.CRAWLBASE_TOKEN, env.CRAWLBASE_JS_TOKEN, useJs);
  } catch (e) {
    errors.push({ api: "crawlbase", message: e instanceof Error ? e.message : String(e) });
  }

  // Try Apyhub
  try {
    return await scrapeApyhub(url, env.APYHUB_TOKEN);
  } catch (e) {
    errors.push({ api: "apyhub", message: e instanceof Error ? e.message : String(e) });
  }

  // Try ScrapingBee
  try {
    return await scrapeScrapingBee(url, env.SCRAPINGBEE_API_KEY);
  } catch (e) {
    errors.push({ api: "scrapingbee", message: e instanceof Error ? e.message : String(e) });
  }

  throw Object.assign(
    new Error("All scraping APIs (Crawlbase, Apyhub, ScrapingBee) failed."),
    { code: "SCRAPING_ALL_FAILED", details: errors }
  );
}

// ── Scrape with a specific named API ───────────────────────────────────────

async function scrapeWithNamedApi(
  url: string,
  apiName: "crawlbase" | "apyhub" | "scrapingbee",
  env: Env,
  useJs: boolean
): Promise<ScrapedContent> {
  switch (apiName) {
    case "crawlbase":
      return await scrapeCrawlbase(url, env.CRAWLBASE_TOKEN, env.CRAWLBASE_JS_TOKEN, useJs);
    case "apyhub":
      return await scrapeApyhub(url, env.APYHUB_TOKEN);
    case "scrapingbee":
      return await scrapeScrapingBee(url, env.SCRAPINGBEE_API_KEY);
  }
}

// ── GLM: Generate candidate profile URLs from query ────────────────────────
//  When search fails and we fall back to scraping, GLM constructs likely URLs.

interface CandidateUrl {
  url: string;
  platform: string;
}

async function generateCandidateUrls(
  ai: Ai,
  query: string,
  platforms: string[]
): Promise<CandidateUrl[]> {
  const prompt = `Given a person's name/info and target platforms, generate likely profile URLs to scrape.
Return ONLY valid JSON array (no markdown, no code fences):
[{"url": "https://linkedin.com/in/firstname-lastname", "platform": "linkedin"}, ...]

Rules:
- Generate 1-3 candidate URLs per platform using common URL patterns
- For LinkedIn: linkedin.com/in/firstname-lastname, linkedin.com/in/flastname
- For GitHub: github.com/firstname, github.com/firstname-lastname
- For Twitter/X: twitter.com/firstname, x.com/firstname
- Use lowercase, hyphens for spaces, remove special characters
- Only generate plausible URLs, do not make up usernames that seem unlikely

Person: ${query}
Platforms: ${platforms.join(", ")}`;

  try {
    const output = await runChat(ai, [
      { role: "system", content: "You output only valid JSON arrays. No explanations, no markdown fences." },
      { role: "user", content: prompt },
    ]);
    const cleaned = output.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned) as CandidateUrl[];
  } catch {
    // Fallback: construct basic URLs manually
    const name = query.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const parts = name.split(/\s+/);
    const first = parts[0] ?? "";
    const last = parts[parts.length - 1] ?? "";
    const candidates: CandidateUrl[] = [];
    for (const p of platforms) {
      const domain = p === "x.com" ? "x.com" : `${p}.com`;
      if (p === "linkedin") {
        candidates.push({ url: `https://${domain}/in/${first}-${last}`, platform: p });
        candidates.push({ url: `https://${domain}/in/${first}${last}`, platform: p });
      } else if (p === "github") {
        candidates.push({ url: `https://${domain}/${first}${last}`, platform: p });
        candidates.push({ url: `https://${domain}/${first}-${last}`, platform: p });
      } else {
        candidates.push({ url: `https://${domain}/${first}${last}`, platform: p });
        candidates.push({ url: `https://${domain}/${first}_${last}`, platform: p });
      }
    }
    return candidates;
  }
}

// ── GLM: Extract profile data from scraped HTML content ────────────────────

async function extractProfilesFromScraped(
  ai: Ai,
  scraped: ScrapedContent[],
  query: string
): Promise<Array<{ name: string; url: string; platform: string; snippet: string; confidence: number }>> {
  const contentPreview = scraped.map((s) =>
    `--- URL: ${s.url} (via ${s.used}) ---\n${s.content.slice(0, 3000)}`
  ).join("\n\n");

  const prompt = `Given scraped web page contents for a person search, extract any profile information found.
Return ONLY valid JSON array (no markdown, no code fences):
[{"name": "Full Name", "url": "https://...", "platform": "linkedin|twitter|github|...", "snippet": "Brief context", "confidence": 0.0-1.0}]

If a page returned no useful profile data (404, login wall, error), skip it.
Set confidence: 1.0 = clearly the right person, 0.7 = likely match, 0.4 = possible match, 0.2 = unlikely.

Person searched: ${query}

Scraped content:
${contentPreview}`;

  try {
    const output = await runChat(ai, [
      { role: "system", content: "You output only valid JSON arrays. No explanations, no markdown fences." },
      { role: "user", content: prompt },
    ]);
    const cleaned = output.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Return minimal entries from the scraped URLs
    return scraped.map((s) => ({
      name: query,
      url: s.url,
      platform: "unknown",
      snippet: `Scraped via ${s.used} — content extraction failed`,
      confidence: 0.3,
    }));
  }
}

// ── GLM: Merge results from Serper + secondary scraper ─────────────────────

async function mergeDualSourceResults(
  ai: Ai,
  serperProfiles: Array<{ name: string; url: string; platform: string; snippet: string; confidence: number }>,
  scrapedProfiles: Array<{ name: string; url: string; platform: string; snippet: string; confidence: number }>,
  query: string,
  sourcesUsed: string[]
): Promise<{
  profiles: Array<{ name: string; url: string; platform: string; snippet: string; confidence: number }>;
  total_found: number;
  sources_used: string[];
  merge_notes: string;
}> {
  const prompt = `You are merging profile search results from two different sources. Deduplicate, organize by confidence, and enrich with data from both sources.
Return ONLY valid JSON (no markdown, no code fences):
{
  "profiles": [{"name": "...", "url": "...", "platform": "...", "snippet": "Combined info from both sources", "confidence": 0.0-1.0}],
  "total_found": number,
  "sources_used": ${JSON.stringify(sourcesUsed)},
  "merge_notes": "Brief explanation of how results were merged and any discrepancies"
}

Rules:
- Merge duplicates: if the same URL/person appears in both, combine snippets and use the higher confidence
- If a profile appears in only one source, keep it but slightly lower confidence
- Organize profiles by confidence (highest first)
- The merge_notes should mention how many duplicates were found and which source had more results

Person searched: ${query}

Source 1 (Serper.dev search results):
${JSON.stringify(serperProfiles)}

Source 2 (Scraped profile pages via ${sourcesUsed[1] ?? "secondary"}):
${JSON.stringify(scrapedProfiles)}`;

  try {
    const output = await runChat(ai, [
      { role: "system", content: "You output only valid JSON. No explanations, no markdown fences." },
      { role: "user", content: prompt },
    ]);
    const cleaned = output.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: simple merge without dedup
    const all = [...serperProfiles, ...scrapedProfiles];
    return {
      profiles: all,
      total_found: all.length,
      sources_used: sourcesUsed,
      merge_notes: "LLM merge failed — results are concatenated without deduplication",
    };
  }
}

// ── Platform needs JS rendering? ───────────────────────────────────────────

const JS_HEAVY_PLATFORMS = new Set(["linkedin", "twitter", "x.com", "instagram", "facebook"]);

// ─── Workers AI Helpers ─────────────────────────────────────────────────────

async function runChat(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
  model = MODELS.chat
): Promise<string> {
  const response = await ai.run(model, {
    messages,
    max_tokens: 4096,
    temperature: 0.3,
  });
  const result = response as { response?: string };
  return result.response ?? "";
}

async function runVision(
  ai: Ai,
  messages: Array<Record<string, unknown>>
): Promise<string> {
  const response = await ai.run(MODELS.vision, {
    messages,
    max_tokens: 4096,
    temperature: 0.3,
  });
  const result = response as { response?: string };
  return result.response ?? "";
}

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const response = await ai.run(MODELS.embedding, {
    text,
  });
  const result = response as { data?: Array<{ embedding?: number[] }> };
  if (result.data?.[0]?.embedding) {
    return result.data[0].embedding;
  }
  throw new Error("Embedding generation returned no data");
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── EXIF Parser (Lightweight, No Dependencies) ────────────────────────────

interface ExifData {
  camera?: string;
  date?: string;
  gps?: { latitude: number; longitude: number };
  resolution?: { width: number; height: number };
  orientation?: number;
  software?: string;
  raw_tags_count: number;
}

function parseExif(arrayBuffer: ArrayBuffer): ExifData {
  const view = new DataView(arrayBuffer);
  const result: ExifData = { raw_tags_count: 0 };

  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
    return result;
  }

  let offset = 2;
  const byteLength = view.byteLength;

  while (offset < byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xffe1) {
      const segmentLength = view.getUint16(offset + 2);
      const exifHeader = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (exifHeader !== "Exif") {
        offset += 2 + segmentLength;
        continue;
      }

      const tiffOffset = offset + 10;
      if (tiffOffset + 8 > byteLength) break;

      const byteOrder = view.getUint16(tiffOffset);
      const littleEndian = byteOrder === 0x4949;

      const ifd0Offset = view.getUint32(tiffOffset + 4, littleEndian);
      const tags = parseIFD(
        view,
        tiffOffset,
        tiffOffset + ifd0Offset,
        littleEndian,
        byteLength
      );
      result.raw_tags_count = tags.size;

      if (tags.has(0x010f)) result.camera = tags.get(0x010f) as string;
      if (tags.has(0x0110))
        result.camera = (result.camera ?? "") + " " + (tags.get(0x0110) as string);
      if (tags.has(0x0132)) result.date = tags.get(0x0132) as string;
      if (tags.has(0x0112)) result.orientation = tags.get(0x0112) as number;
      if (tags.has(0x0131)) result.software = tags.get(0x0131) as string;

      const xRes = tags.get(0x011a);
      const yRes = tags.get(0x011b);
      if (typeof xRes === "number" && typeof yRes === "number") {
        result.resolution = { width: xRes, height: yRes };
      }

      if (tags.has(0x8825)) {
        const gpsIfdOffset = tags.get(0x8825) as number;
        if (typeof gpsIfdOffset === "number") {
          const gpsTags = parseIFD(
            view,
            tiffOffset,
            tiffOffset + gpsIfdOffset,
            littleEndian,
            byteLength
          );
          const lat = parseGPSCoordinate(gpsTags, 0x0001, 0x0002, littleEndian);
          const lng = parseGPSCoordinate(gpsTags, 0x0003, 0x0004, littleEndian);
          if (lat !== null && lng !== null) {
            result.gps = { latitude: lat, longitude: lng };
          }
        }
      }

      break;
    }

    if ((marker & 0xff00) !== 0xff00) break;
    const segLen = view.getUint16(offset + 2);
    offset += 2 + segLen;
  }

  return result;
}

function parseIFD(
  view: DataView,
  tiffBase: number,
  ifdOffset: number,
  littleEndian: boolean,
  byteLength: number
): Map<number, string | number> {
  const tags = new Map<number, string | number>();
  if (ifdOffset + 2 > byteLength) return tags;

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  let tagCount = 0;

  for (let i = 0; i < entryCount && tagCount < 64; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > byteLength) break;

    const tagId = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);

    const typeSizes: Record<number, number> = {
      1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8,
    };
    const unitSize = typeSizes[type] ?? 1;
    const totalSize = unitSize * count;

    let valueOffset = entryOffset + 8;
    if (totalSize > 4) {
      valueOffset = tiffBase + view.getUint32(entryOffset + 8, littleEndian);
    }

    try {
      if (type === 2 && count > 0) {
        let str = "";
        for (let j = 0; j < count - 1 && valueOffset + j < byteLength; j++) {
          const ch = view.getUint8(valueOffset + j);
          if (ch === 0) break;
          str += String.fromCharCode(ch);
        }
        tags.set(tagId, str);
      } else if (type === 3 && count === 1) {
        tags.set(tagId, view.getUint16(valueOffset, littleEndian));
      } else if (type === 4 && count === 1) {
        tags.set(tagId, view.getUint32(valueOffset, littleEndian));
      } else if (type === 5 && count === 1) {
        const num = view.getUint32(valueOffset, littleEndian);
        const den = view.getUint32(valueOffset + 4, littleEndian);
        if (den !== 0) tags.set(tagId, num / den);
      } else if (tagId === 0x8825 && type === 4 && count === 1) {
        tags.set(tagId, view.getUint32(valueOffset, littleEndian));
      }
    } catch {
      // Silently skip unreadable tags
    }

    tagCount++;
  }

  return tags;
}

function parseGPSCoordinate(
  gpsTags: Map<number, string | number>,
  refTag: number,
  valueTag: number,
  _littleEndian: boolean
): number | null {
  const ref = gpsTags.get(refTag);
  const val = gpsTags.get(valueTag);
  if (typeof val !== "number" || typeof ref !== "string") return null;
  const sign = ref === "S" || ref === "W" ? -1 : 1;
  return sign * Math.abs(val);
}

// ─── Web Metadata Extractor ─────────────────────────────────────────────────

interface WebMetadata {
  title: string;
  description: string;
  og_image?: string;
  canonical_url?: string;
  key_links: string[];
  headers: Record<string, string>;
  status: number;
}

async function extractWebMetadata(url: string): Promise<WebMetadata> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AurorResearchBot/1.0; +https://auror.app)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });

  const html = await response.text();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i
  ) ?? html.match(
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i
  );
  const description = descMatch ? descMatch[1].trim() : "";

  const ogImgMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([\s\S]*?)["']/i
  ) ?? html.match(
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:image["']/i
  );
  const og_image = ogImgMatch ? ogImgMatch[1].trim() : undefined;

  const canonicalMatch = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["']/i
  );
  const canonical_url = canonicalMatch ? canonicalMatch[1].trim() : undefined;

  const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  const key_links: string[] = [];
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html)) !== null && key_links.length < 20) {
    const href = linkMatch[1];
    if (
      href.startsWith("http") &&
      !href.includes("javascript:") &&
      !href.includes(".css") &&
      !href.includes(".js")
    ) {
      key_links.push(href);
    }
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });

  return {
    title,
    description,
    ...(og_image ? { og_image } : {}),
    ...(canonical_url ? { canonical_url } : {}),
    key_links,
    headers,
    status: response.status,
  };
}

// ─── TASK 0: process (Generic Input Handler) ────────────────────────────────

/**
 * The primary entry point for the Auror webapp.
 * Accepts text, documents, or images and auto-routes to the right AI pipeline.
 * This is where user input from the webapp lands first.
 */
async function handleProcess(
  payload: ProcessPayload,
  env: Env,
  requestId: string,
  startTime: number
): Promise<{ data: unknown; modelUsed: string; attempts?: number }> {
  const { input_type, content, mime_type, filename, instructions, mode } = payload;

  if (!isNonEmptyString(content, 1, MAX_BASE64_LENGTH)) {
    throw Object.assign(
      new Error(`content must be a non-empty string (max ${MAX_BASE64_LENGTH} chars for base64)`),
      { code: "VALIDATION_ERROR" }
    );
  }

  if (!isNonEmptyString(instructions, 1, 5000)) {
    throw Object.assign(
      new Error("instructions must be a non-empty string (1-5000 chars)"),
      { code: "VALIDATION_ERROR" }
    );
  }

  if (!["analyze", "summarize", "extract", "compare", "search", "translate"].includes(mode)) {
    throw Object.assign(
      new Error('mode must be one of: analyze, summarize, extract, compare, search, translate'),
      { code: "VALIDATION_ERROR" }
    );
  }

  // ── Route based on input_type ──

  if (input_type === "text") {
    // Pure text input → glm-4.7-flash
    return await processTextInput(content, instructions, mode, env);
  }

  if (input_type === "image_base64") {
    // Image input → vision model
    return await processImageInput(content, mime_type, filename, instructions, mode, env);
  }

  if (input_type === "document_base64") {
    // Document input
    // The webapp converts PDFs to images on the client side (PDF→canvas→base64).
    // For other document types (txt, csv, html), we may receive raw base64 text.
    if (isImageMimeType(mime_type)) {
      // PDF already converted to image by webapp
      return await processImageInput(content, mime_type, filename, instructions, mode, env);
    }

    if (isDocumentMimeType(mime_type)) {
      // Try to decode as text for text-based documents
      try {
        const decoded = atob(content.replace(/^data:[^;]+;base64,/, ""));
        // If it's a text-based document, process as text
        if (decoded.length < MAX_TEXT_LENGTH) {
          return await processTextInput(
            `[Document: ${filename ?? "unknown"}]\n\n${decoded}`,
            instructions,
            mode,
            env
          );
        }
      } catch {
        // If decoding fails, treat as image for vision model
      }
      // Large or binary documents → vision model (webapp should have converted to image)
      return await processImageInput(content, mime_type, filename, instructions, mode, env);
    }

    // Unknown MIME type → try vision model as last resort
    return await processImageInput(content, mime_type, filename, instructions, mode, env);
  }

  throw Object.assign(new Error(`Invalid input_type: "${input_type}"`), { code: "VALIDATION_ERROR" });
}

/** Process plain text input through glm-4.7-flash */
async function processTextInput(
  text: string,
  instructions: string,
  mode: string,
  env: Env
): Promise<{ data: unknown; modelUsed: string }> {
  const modeDescriptions: Record<string, string> = {
    analyze: "Analyze the following content in depth. Identify key themes, entities, sentiments, and insights.",
    summarize: "Provide a concise but comprehensive summary of the following content.",
    extract: "Extract all structured data from the following content. Return as clean JSON.",
    compare: "Compare and contrast the key points in the following content.",
    search: "Identify the main topics and suggest what external information would be relevant to search for.",
    translate: "Translate the following content. If no target language is specified in instructions, translate to English.",
  };

  const systemPrompt = `You are an AI assistant for the Auror platform. ${modeDescriptions[mode] ?? modeDescriptions.analyze}

IMPORTANT FORMATTING RULES:
- If the mode is "extract", return ONLY valid JSON (no markdown fences)
- Otherwise, return well-structured plain text with clear sections
- Be thorough and accurate
- Reference specific parts of the input when making claims`;

  const llmOutput = await runChat(env.AI, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${instructions}\n\n---\n\n${text.slice(0, 30000)}` },
  ]);

  // If mode is "extract", try to parse as JSON
  if (mode === "extract") {
    try {
      const cleaned = llmOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return { data: parsed, modelUsed: MODELS.chat };
    } catch {
      // If parsing fails, return as text
      return { data: { extracted_text: llmOutput, format: "text" }, modelUsed: MODELS.chat };
    }
  }

  return {
    data: { response: llmOutput, input_length: text.length, mode },
    modelUsed: MODELS.chat,
  };
}

/** Process image/document input through vision model */
async function processImageInput(
  base64Content: string,
  mimeType: string | undefined,
  filename: string | undefined,
  instructions: string,
  mode: string,
  env: Env
): Promise<{ data: unknown; modelUsed: string }> {
  const dataUri = base64Content.startsWith("data:")
    ? base64Content
    : `data:${mimeType ?? "image/jpeg"};base64,${base64Content}`;

  const modePrompts: Record<string, string> = {
    analyze: "Analyze this image/document in depth. Describe all visible elements, text, structure, and context.",
    summarize: "Provide a concise summary of what is shown in this image/document.",
    extract: "Extract all data from this image/document. Return ONLY valid JSON with all extracted fields. No markdown fences.",
    compare: "Analyze this image/document and identify key elements that could be compared with other sources.",
    search: "Identify the main topics in this image/document and suggest relevant search queries.",
    translate: "Extract and translate all text visible in this image/document.",
  };

  const visionMessages = [
    { type: "image_url", image_url: { url: dataUri } },
    { type: "text", text: `${modePrompts[mode] ?? modePrompts.analyze}\n\nUser instructions: ${instructions}` },
  ];

  const visionOutput = await runVision(env.AI, [
    { role: "user", content: visionMessages },
  ]);

  if (mode === "extract") {
    try {
      const cleaned = visionOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        data: {
          ...parsed,
          _source_file: filename,
          _source_type: mimeType,
        },
        modelUsed: MODELS.vision,
      };
    } catch {
      // Fall through to text response
    }
  }

  return {
    data: {
      response: visionOutput,
      source_file: filename ?? "unknown",
      source_type: mimeType ?? "image/jpeg",
      mode,
      confidence: 0.85,
    },
    modelUsed: MODELS.vision,
  };
}

// ─── TASK 1: social_search ──────────────────────────────────────────────────
//
//  Flow:
//  1. GLM converts user query → search query with site: operators
//  2. Serper.dev (main) → if fails → Crawlbase → Apyhub → ScrapingBee (fallback)
//  3. If user selected secondary_scraper → also scrape top URLs with that API
//  4. GLM normalizes all results into profiles JSON
//  5. If dual source → GLM merges and organizes
//  6. Return raw_data (JSON from APIs) + normalized profiles

async function handleSocialSearch(
  payload: SocialSearchPayload,
  env: Env,
  requestId: string,
  startTime: number
): Promise<{ data: unknown; modelUsed: string; attempts?: number }> {
  if (!isNonEmptyString(payload.query, 2, 500)) {
    throw Object.assign(new Error("query must be a non-empty string (2-500 chars)"), { code: "VALIDATION_ERROR" });
  }

  const platforms = (payload.platforms ?? [])
    .filter((p) => SUPPORTED_PLATFORMS.has(p.toLowerCase()));

  if (platforms.length === 0) {
    throw Object.assign(
      new Error(`platforms must include at least one of: ${[...SUPPORTED_PLATFORMS].join(", ")}`),
      { code: "VALIDATION_ERROR" }
    );
  }

  const maxResults = Math.min(
    Math.max(payload.max_results ?? 10, 1),
    parseInt(env.MAX_RESULTS_SOCIAL ?? "20", 10)
  );

  const secondaryScraper = payload.secondary_scraper;
  if (secondaryScraper && !["crawlbase", "apyhub", "scrapingbee"].includes(secondaryScraper)) {
    throw Object.assign(
      new Error('secondary_scraper must be "crawlbase", "apyhub", or "scrapingbee"'),
      { code: "VALIDATION_ERROR" }
    );
  }

  // ── Step 1: Build search query with site: operators ──
  const siteClauses = platforms
    .map((p) => `site:${p}.com OR site:${p}.io OR site:${p}.dev`)
    .join(" OR ");
  const searchQuery = `${payload.query} (${siteClauses})`;

  // ── Step 2: Execute search via Serper.dev (main) with scraping fallback ──
  let rawSearchData: Array<{ title: string; url: string; snippet: string }> = [];
  let sourceApi = "serper";
  let attempts = 1;
  let serperFailed = false;

  try {
    const serper = await searchSerper(searchQuery, maxResults, env.SERPER_API_KEY);
    rawSearchData = serper.results.map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet ?? "",
    }));
    sourceApi = serper.used;
  } catch (serperError) {
    serperFailed = true;
    attempts = 2;

    // Fallback: use GLM to generate candidate URLs, then scrape them
    const candidates = await generateCandidateUrls(env.AI, payload.query, platforms);
    const scrapedResults: ScrapedContent[] = [];
    const scrapeErrors: Array<{ api: string; message: string }> = [];

    for (const candidate of candidates.slice(0, maxResults)) {
      const useJs = JS_HEAVY_PLATFORMS.has(candidate.platform);
      try {
        const scraped = await scrapeWithFallback(candidate.url, env, useJs);
        scrapedResults.push(scraped);
      } catch (e) {
        scrapeErrors.push({
          api: "fallback_chain",
          message: `Failed to scrape ${candidate.url}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    if (scrapedResults.length === 0) {
      throw Object.assign(
        new Error("Serper.dev search failed and all scraping fallback APIs also failed. Please try again later."),
        {
          code: "SEARCH_API_UNAVAILABLE",
          details: {
            serper_error: serperError instanceof Error ? serperError.message : String(serperError),
            scrape_errors: scrapeErrors,
          },
        }
      );
    }

    // Extract profiles from scraped content via GLM
    const scrapedProfiles = await extractProfilesFromScraped(env.AI, scrapedResults, payload.query);
    rawSearchData = scrapedProfiles.map((p) => ({
      title: p.name,
      url: p.url,
      snippet: p.snippet,
    }));
    sourceApi = scrapedResults.map((s) => s.used).filter((v, i, a) => a.indexOf(v) === i).join("+");
    attempts = 2 + scrapeErrors.length;
  }

  // ── Step 3: GLM normalize search results into profiles ──
  const normalizationPrompt = `You are a profile extraction assistant. Given search results, extract social media/web profiles.
Return ONLY valid JSON with this exact structure (no markdown, no code fences):
{
  "profiles": [
    {"name": "Full Name or Username", "url": "https://...", "platform": "linkedin|twitter|github|...", "snippet": "Brief context from result", "confidence": 0.0-1.0}
  ],
  "total_found": number,
  "source_api_used": "${sourceApi}"
}

Search results:
${JSON.stringify(rawSearchData.slice(0, maxResults))}

Extract as many relevant profiles as possible. Set confidence based on relevance (1.0 = exact match, 0.3 = tangential).`;

  let normalizedProfiles: Array<{ name: string; url: string; platform: string; snippet: string; confidence: number }>;

  try {
    const llmOutput = await runChat(env.AI, [
      { role: "system", content: "You output only valid JSON. No explanations, no markdown fences." },
      { role: "user", content: normalizationPrompt },
    ]);
    const cleaned = llmOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    normalizedProfiles = parsed.profiles ?? [];
  } catch {
    normalizedProfiles = rawSearchData.slice(0, maxResults).map((r) => ({
      name: r.title,
      url: r.url,
      platform: "unknown",
      snippet: r.snippet,
      confidence: 0.5,
    }));
  }

  // ── Step 4: If secondary_scraper selected, run it on top profile URLs ──
  if (secondaryScraper && !serperFailed && normalizedProfiles.length > 0) {
    const topUrls = normalizedProfiles
      .filter((p) => p.confidence >= 0.5)
      .slice(0, 5)
      .map((p) => ({
        url: p.url,
        platform: p.platform,
        useJs: JS_HEAVY_PLATFORMS.has(p.platform),
      }));

    const secondaryScraped: ScrapedContent[] = [];
    for (const target of topUrls) {
      try {
        const scraped = await scrapeWithNamedApi(target.url, secondaryScraper, env, target.useJs);
        secondaryScraped.push(scraped);
      } catch {
        // Skip failed scrapes silently
      }
    }

    if (secondaryScraped.length > 0) {
      // Extract profiles from secondary scraper results
      const secondaryProfiles = await extractProfilesFromScraped(env.AI, secondaryScraped, payload.query);

      // Merge both sources via GLM
      const merged = await mergeDualSourceResults(
        env.AI,
        normalizedProfiles,
        secondaryProfiles,
        payload.query,
        ["serper", secondaryScraper]
      );

      return {
        data: {
          raw_data: {
            serper_results: rawSearchData,
            secondary_scraped: secondaryScraped.map((s) => ({
              url: s.url,
              source: s.used,
              content_preview: s.content.slice(0, 500),
            })),
          },
          ...merged,
        },
        modelUsed: `${MODELS.chat}+serper+${secondaryScraper}`,
        attempts,
      };
    }
  }

  // ── Step 5: Return results (single source) ──
  const resultData = serperFailed
    ? {
        raw_data: { search_query: searchQuery, fallback_used: sourceApi },
        profiles: normalizedProfiles,
        total_found: normalizedProfiles.length,
        source_api_used: sourceApi,
      }
    : {
        raw_data: { search_query: searchQuery, serper_results: rawSearchData },
        profiles: normalizedProfiles,
        total_found: normalizedProfiles.length,
        source_api_used: sourceApi,
      };

  return {
    data: resultData,
    modelUsed: `${MODELS.chat}+${sourceApi}`,
    attempts,
  };
}

// ─── TASK 2: semantic_matcher ───────────────────────────────────────────────

async function handleSemanticMatcher(
  payload: SemanticMatcherPayload,
  env: Env,
  requestId: string,
  startTime: number
): Promise<{ data: unknown; modelUsed: string }> {
  const maxDocs = parseInt(env.MAX_DOCUMENTS_SEMANTIC ?? "3", 10);
  const documents = payload.documents;

  if (!Array.isArray(documents) || documents.length < 2) {
    throw Object.assign(new Error("documents must be an array with at least 2 items"), { code: "VALIDATION_ERROR" });
  }

  if (documents.length > maxDocs) {
    throw Object.assign(
      new Error(`Maximum ${maxDocs} documents allowed, received ${documents.length}`),
      { code: "VALIDATION_ERROR" }
    );
  }

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc.id || typeof doc.id !== "string") {
      throw Object.assign(new Error(`documents[${i}].id must be a non-empty string`), { code: "VALIDATION_ERROR" });
    }
    if (!doc.content || typeof doc.content !== "string") {
      throw Object.assign(new Error(`documents[${i}].content must be a non-empty string`), { code: "VALIDATION_ERROR" });
    }
    if (doc.content.length > MAX_TEXT_LENGTH) {
      throw Object.assign(
        new Error(`documents[${i}].content exceeds ${MAX_TEXT_LENGTH} character limit`),
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  const embeddings: Array<{ id: string; embedding: number[] }> = [];
  for (const doc of documents) {
    try {
      const embedding = await generateEmbedding(env.AI, doc.content.slice(0, 8000));
      embeddings.push({ id: doc.id, embedding });
    } catch (embError) {
      throw Object.assign(
        new Error(`Failed to generate embedding for document "${doc.id}": ${
          embError instanceof Error ? embError.message : String(embError)
        }`),
        { code: "EMBEDDING_FAILED" }
      );
    }
  }

  const ids = embeddings.map((e) => e.id);
  const similarityMatrix: Record<string, Record<string, number>> = {};
  for (const idA of ids) {
    similarityMatrix[idA] = {};
  }
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i; j < embeddings.length; j++) {
      const sim = cosineSimilarity(embeddings[i].embedding, embeddings[j].embedding);
      similarityMatrix[embeddings[i].id][embeddings[j].id] = Math.round(sim * 10000) / 10000;
      similarityMatrix[embeddings[j].id][embeddings[i].id] = Math.round(sim * 10000) / 10000;
    }
  }

  const docsSummary = documents
    .map((d) => `[${d.id}]: ${d.content.slice(0, 2000)}`)
    .join("\n\n");

  const analysisPrompt = `You are a semantic analysis assistant. Compare these documents and return ONLY valid JSON (no markdown fences):
{
  "thematic_overlap": "Description of shared themes",
  "contradictions": ["Any contradictions found, or empty array"],
  "divergence_score": 0.0-1.0,
  "shared_entities": ["Named entities or concepts shared between docs"],
  "qualitative_analysis": "In-depth comparison of perspectives, depth, and focus differences"
}

Documents:
${docsSummary}

Similarity matrix:
${JSON.stringify(similarityMatrix)}`;

  try {
    const llmOutput = await runChat(env.AI, [
      { role: "system", content: "You output only valid JSON. No explanations, no markdown fences." },
      { role: "user", content: analysisPrompt },
    ]);

    const cleaned = llmOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const qualitative = JSON.parse(cleaned);

    return {
      data: { similarity_matrix: similarityMatrix, ...qualitative },
      modelUsed: `${MODELS.embedding}+${MODELS.chat}`,
    };
  } catch (llmError) {
    return {
      data: {
        similarity_matrix: similarityMatrix,
        thematic_overlap: "LLM analysis unavailable",
        contradictions: [],
        divergence_score: null,
        shared_entities: [],
        qualitative_analysis: `LLM qualitative analysis failed: ${
          llmError instanceof Error ? llmError.message : String(llmError)
        }`,
      },
      modelUsed: MODELS.embedding,
    };
  }
}

// ─── TASK 3: data_extractor ─────────────────────────────────────────────────

async function handleDataExtractor(
  payload: DataExtractorPayload,
  env: Env,
  requestId: string,
  startTime: number
): Promise<{ data: unknown; modelUsed: string }> {
  const { type, source, extract_mode, mime_type, filename } = payload;

  if (!isNonEmptyString(source, 1, MAX_BASE64_LENGTH)) {
    throw Object.assign(new Error("source must be a non-empty string"), { code: "VALIDATION_ERROR" });
  }

  if (!["url", "image_base64", "document_base64"].includes(type)) {
    throw Object.assign(new Error('type must be "url", "image_base64", or "document_base64"'), { code: "VALIDATION_ERROR" });
  }

  if (!["metadata", "text", "structured"].includes(extract_mode)) {
    throw Object.assign(new Error('extract_mode must be "metadata", "text", or "structured"'), { code: "VALIDATION_ERROR" });
  }

  const result: Record<string, unknown> = {};

  if (type === "url") {
    try {
      const webMeta = await extractWebMetadata(source);
      result.web_metadata = webMeta;

      if (extract_mode === "text" || extract_mode === "structured") {
        const extractPrompt =
          extract_mode === "structured"
            ? `Extract structured data from this web page. Return ONLY valid JSON with keys like: title, description, main_topics, key_facts, contact_info, author, publish_date.\n\nPage data: ${JSON.stringify(webMeta)}`
            : `Summarize the key textual content from this web page in plain text.\n\nPage data: ${JSON.stringify(webMeta)}`;

        const llmOutput = await runChat(env.AI, [
          {
            role: "system",
            content: extract_mode === "structured"
              ? "You output only valid JSON. No markdown fences."
              : "You output concise, accurate text summaries.",
          },
          { role: "user", content: extractPrompt },
        ]);

        if (extract_mode === "structured") {
          try {
            const cleaned = llmOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
            result.extracted_fields = JSON.parse(cleaned);
          } catch {
            result.extracted_fields = { raw: llmOutput };
          }
        } else {
          result.ocr_text = llmOutput;
        }
      }
    } catch (fetchError) {
      throw Object.assign(
        new Error(`Failed to fetch URL: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`),
        { code: "URL_FETCH_FAILED" }
      );
    }
  } else if (type === "document_base64") {
    // ── Document path (PDF→image already handled by webapp, but handle text docs) ──
    if (isImageMimeType(mime_type)) {
      // Webapp already converted to image — use vision path
      return handleDataExtractorImage(source, extract_mode, filename, env);
    }

    // Try to decode text-based documents
    try {
      const decoded = atob(source.replace(/^data:[^;]+;base64,/, ""));
      if (decoded.length < MAX_TEXT_LENGTH) {
        result.ocr_text = decoded;
        result.source_file = filename;

        if (extract_mode === "structured") {
          const structPrompt = `Extract structured data from this document text. Return ONLY valid JSON.\n\n${decoded.slice(0, 15000)}`;
          const llmOutput = await runChat(env.AI, [
            { role: "system", content: "You output only valid JSON. No markdown fences." },
            { role: "user", content: structPrompt },
          ]);
          try {
            const cleaned = llmOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
            result.extracted_fields = JSON.parse(cleaned);
          } catch {
            result.extracted_fields = { raw: llmOutput };
          }
        }

        result.confidence = 0.95;
        return { data: result, modelUsed: MODELS.chat };
      }
    } catch {
      // Fall through to vision model
    }

    // Large or binary document → vision model
    return handleDataExtractorImage(source, extract_mode, filename, env);
  } else {
    // ── Image path ──
    return handleDataExtractorImage(source, extract_mode, filename, env);
  }

  return { data: result, modelUsed: type === "url" ? MODELS.chat : MODELS.vision };
}

/** Shared image extraction logic used by data_extractor for images and document_base64 */
async function handleDataExtractorImage(
  source: string,
  extractMode: string,
  filename: string | undefined,
  env: Env
): Promise<{ data: unknown; modelUsed: string }> {
  const result: Record<string, unknown> = {};

  if (source.length < 100) {
    throw Object.assign(new Error("Image/document base64 source is too short to be valid"), { code: "VALIDATION_ERROR" });
  }

  // Extract EXIF
  try {
    const binaryStr = atob(source.replace(/^data:image\/\w+;base64,/, ""));
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const exifData = parseExif(bytes.buffer);
    if (exifData.raw_tags_count > 0) {
      result.exif_data = exifData;
    }
  } catch {
    // EXIF extraction failed silently
  }

  const dataUri = source.startsWith("data:")
    ? source
    : `data:image/jpeg;base64,${source}`;

  const visionPrompts: Record<string, string> = {
    metadata: "Describe the metadata and visual properties of this image/document. Include any text, logos, or identifiable elements.",
    text: "Extract ALL text visible in this image/document using OCR. Return the text exactly as it appears, preserving structure and layout.",
    structured: `Analyze this image/document and extract structured data. Return ONLY valid JSON with keys: { ocr_text, visual_description, detected_objects, colors, text_language, confidence }. No markdown fences.`,
  };

  try {
    const visionMessages = [
      { type: "image_url", image_url: { url: dataUri } },
      { type: "text", text: visionPrompts[extractMode] },
    ];

    const visionOutput = await runVision(env.AI, [
      { role: "user", content: visionMessages },
    ]);

    if (extractMode === "structured") {
      try {
        const cleaned = visionOutput.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        result.extracted_fields = JSON.parse(cleaned);
      } catch {
        result.extracted_fields = { raw: visionOutput };
      }
    } else if (extractMode === "text") {
      result.ocr_text = visionOutput;
    } else {
      result.visual_description = visionOutput;
    }

    result.confidence = 0.85;
    if (filename) result.source_file = filename;
  } catch (visionError) {
    throw Object.assign(
      new Error(`Vision model failed: ${visionError instanceof Error ? visionError.message : String(visionError)}`),
      { code: "VISION_FAILED" }
    );
  }

  return { data: result, modelUsed: MODELS.vision };
}

// ─── TASK 4: chat_with_media ────────────────────────────────────────────────

async function handleChatWithMedia(
  payload: ChatWithMediaPayload,
  env: Env,
  requestId: string,
  startTime: number
): Promise<{ data: unknown; modelUsed: string }> {
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    throw Object.assign(new Error("images must be a non-empty array"), { code: "VALIDATION_ERROR" });
  }

  if (payload.images.length > 10) {
    throw Object.assign(new Error("Maximum 10 images/documents per request"), { code: "VALIDATION_ERROR" });
  }

  if (!isNonEmptyString(payload.prompt, 1, 10000)) {
    throw Object.assign(new Error("prompt must be a non-empty string (1-10000 chars)"), { code: "VALIDATION_ERROR" });
  }

  if (!["qa", "summarize", "extract"].includes(payload.context_mode ?? "")) {
    throw Object.assign(new Error('context_mode must be "qa", "summarize", or "extract"'), { code: "VALIDATION_ERROR" });
  }

  const systemPrompts: Record<string, string> = {
    qa: "You are a helpful assistant answering questions about the provided images/documents. Be precise and reference visual elements.",
    summarize: "You are a summarization assistant. Provide a concise summary of what is shown across the provided images/documents.",
    extract: "You are a data extraction assistant. Extract all structured information from the images/documents. Return JSON if the data is structured, otherwise return clean text.",
  };

  const visionContent: Array<Record<string, unknown>> = [];

  for (const img of payload.images) {
    if (!img.base64 || typeof img.base64 !== "string") {
      throw Object.assign(new Error("Each image must have a non-empty base64 string"), { code: "VALIDATION_ERROR" });
    }

    const dataUri = img.base64.startsWith("data:")
      ? img.base64
      : `data:image/jpeg;base64,${img.base64}`;

    visionContent.push({
      type: "image_url",
      image_url: { url: dataUri },
    });
  }

  visionContent.push({
    type: "text",
    text: payload.prompt,
  });

  try {
    const responseText = await runVision(env.AI, [
      { role: "system", content: systemPrompts[payload.context_mode] },
      { role: "user", content: visionContent },
    ]);

    return {
      data: {
        response: responseText,
        source_images: payload.images.map((img) => img.name),
        processing_ms: latency(startTime),
      },
      modelUsed: MODELS.vision,
    };
  } catch (visionError) {
    throw Object.assign(
      new Error(`Vision model failed: ${visionError instanceof Error ? visionError.message : String(visionError)}`),
      { code: "VISION_FAILED" }
    );
  }
}

// ─── Task Dispatcher ────────────────────────────────────────────────────────

async function dispatchTask(
  task: string,
  payload: unknown,
  env: Env,
  requestId: string,
  startTime: number,
  outputFormat: OutputFormat
): Promise<AurorResponse> {
  try {
    let taskResult: { data: unknown; modelUsed: string; attempts?: number };

    switch (task) {
      case "process":
        taskResult = await handleProcess(payload as ProcessPayload, env, requestId, startTime);
        break;

      case "social_search":
        taskResult = await handleSocialSearch(payload as SocialSearchPayload, env, requestId, startTime);
        break;

      case "semantic_matcher":
        taskResult = await handleSemanticMatcher(payload as SemanticMatcherPayload, env, requestId, startTime);
        break;

      case "data_extractor":
        taskResult = await handleDataExtractor(payload as DataExtractorPayload, env, requestId, startTime);
        break;

      case "chat_with_media":
        taskResult = await handleChatWithMedia(payload as ChatWithMediaPayload, env, requestId, startTime);
        break;

      default:
        return error(
          "UNKNOWN_TASK",
          `Unknown task: "${task}". Valid tasks: ${[...VALID_TASKS].join(", ")}`,
          requestId
        );
    }

    // ── Apply output format (json / txt / both) ──
    const instructions = (payload as { instructions?: string })?.instructions;
    return await applyOutputFormat(
      env.AI,
      task,
      taskResult.data,
      outputFormat,
      requestId,
      taskResult.modelUsed,
      startTime,
      taskResult.attempts,
      instructions
    );
  } catch (err) {
    const code = (err as { code?: string }).code ?? "TASK_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const details = (err as { details?: unknown }).details;
    return error(code, message, requestId, details);
  }
}

// ─── Main Worker Entry ──────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    const requestId = generateRequestId();
    const origin = request.headers.get("Origin");

    // ── CORS Preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    const commonHeaders = {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env),
    };

    // ── GET /status ──
    if (request.method === "GET" && new URL(request.url).pathname === "/status") {
      const statusData = {
        status: "active",
        tier: "free",
        endpoints: ["/status", "/"],
        tasks: [...VALID_TASKS],
        models: [MODELS.chat, MODELS.embedding, MODELS.vision],
        output_formats: ["json", "txt", "both"],
        limits: {
          daily_searches: "2000",
          vision_req: "10000",
          max_upload_mb: 20,
          max_documents_semantic: parseInt(env.MAX_DOCUMENTS_SEMANTIC ?? "3", 10),
          max_results_social: parseInt(env.MAX_RESULTS_SOCIAL ?? "20", 10),
          max_text_chars: MAX_TEXT_LENGTH,
        },
        request_id: requestId,
      };

      return new Response(JSON.stringify(success(statusData, requestId, "none", startTime)), {
        status: 200,
        headers: commonHeaders,
      });
    }

    // ── Only POST / is accepted for tasks ──
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify(error("METHOD_NOT_ALLOWED", "Only POST and GET /status are supported", requestId)),
        { status: 405, headers: commonHeaders }
      );
    }

    // ── Authentication ──
    if (!authenticate(request, env)) {
      return new Response(
        JSON.stringify(error("UNAUTHORIZED", "Invalid or missing Bearer token", requestId)),
        { status: 401, headers: commonHeaders }
      );
    }

    // ── Parse Request Body ──
    let body: TaskRequest;
    try {
      const raw = await request.json();
      body = raw as TaskRequest;
    } catch {
      return new Response(
        JSON.stringify(error("INVALID_JSON", "Request body must be valid JSON", requestId)),
        { status: 400, headers: commonHeaders }
      );
    }

    // ── Validate Task ──
    if (!isNonEmptyString(body.task, 1, 100)) {
      return new Response(
        JSON.stringify(error("VALIDATION_ERROR", '"task" must be a non-empty string', requestId)),
        { status: 400, headers: commonHeaders }
      );
    }

    if (!VALID_TASKS.has(body.task)) {
      return new Response(
        JSON.stringify(
          error(
            "UNKNOWN_TASK",
            `Unknown task: "${body.task}". Valid tasks: ${[...VALID_TASKS].join(", ")}`,
            requestId
          )
        ),
        { status: 400, headers: commonHeaders }
      );
    }

    if (!body.payload || typeof body.payload !== "object") {
      return new Response(
        JSON.stringify(error("VALIDATION_ERROR", '"payload" must be a non-null object', requestId)),
        { status: 400, headers: commonHeaders }
      );
    }

    // ── Validate output_format ──
    const outputFormat: OutputFormat =
      body.output_format && VALID_OUTPUT_FORMATS.has(body.output_format)
        ? body.output_format!
        : "json";

    // ── Dispatch Task ──
    const result = await dispatchTask(body.task, body.payload, env, requestId, startTime, outputFormat);
    const status = result.success ? 200 : 400;
    return new Response(JSON.stringify(result), { status, headers: commonHeaders });
  },
} satisfies ExportedHandler<Env>;
