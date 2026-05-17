# Auror Research Worker v2

**Input → AI → Output: texto o documentos entran, JSON y/o .txt sale.**  
Cloudflare Workers + Workers AI en el edge.

---

## Flujo de la plataforma Auror
```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USUARIO EN LA WEBAPP                            │
│                                                                        │
│   Escribe texto ──────────────┐                                        │
│   Sube documento (≤20MB) ─────┤                                        │
│   Sube imagen ────────────────┘                                        │
│                                                                        │
│   Elige modo: analizar | resumir | extraer | comparar | buscar         │
│   Elige formato salida: JSON | .txt | ambos                            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     JS DE LA WEBAPP (cliente)                          │
│                                                                        │
│  1. Lee el input del usuario                                           │
│  2. Si es PDF → convierte a imagen (pdf.js + canvas)                  │
│  3. Si es imagen → base64 directo                                      │
│  4. Si es texto → empaqueta como string                                │
│  5. Construye JSON: { task, payload, output_format }                   │
│  6. Envía POST con Bearer token                                        │
│  7. Recibe respuesta con data + text_output                            │
│  8. Muestra resultado + botón descarga .txt/.json                      │
│  9. Guarda meta en localStorage para dashboard/historial               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTPS POST (Bearer API_KEY)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    auror-research-worker (Edge)                         │
│                                                                        │
│  Auth → CORS → Validar → Dispatch → Procesar → Normalizar → Responder │
│                                                                        │
│  ┌──────────┐  ┌────────────────┐  ┌───────────────┐  ┌────────────┐  │
│  │ process  │  │ social_search  │  │semantic_match │  │data_extract│  │
│  │ (nuevo!) │  │ Brave→Serper   │  │ Embeddings +  │  │ URL/Image  │  │
│  │          │  │ → LLM norm     │  │ LLM qualitat. │  │ Doc+EXIF   │  │
│  │ Texto →  │  │                │  │               │  │            │  │
│  │ Doc →    │  └────────────────┘  └───────────────┘  └────────────┘  │
│  │ Imagen → │                                                          │
│  │ AI pipe  │  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │          │  │chat_with_media │  │   Normalización de salida    │   │
│  └──────────┘  │ Multi-imagen   │  │   (glm-4.7-flash)           │   │
│                │ + prompt       │  │                              │   │
│                └────────────────┘  │  data → text_output (.txt)  │   │
│                                    │  si output_format="txt|both" │   │
│                                    └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Tareas soportadas

### 0. `process` — Tarea genérica (punto de entrada principal)

**Esta es la tarea que la webapp usa por defecto.** Recibe texto, documentos o imágenes del usuario y los enruta automáticamente al pipeline de IA correcto.

**Payload:**
```json
{
  "input_type": "text | document_base64 | image_base64",
  "content": "El texto o base64 que el usuario proporcionó",
  "mime_type": "application/pdf",
  "filename": "contrato.pdf",
  "instructions": "Extrae las cláusulas de penalización",
  "mode": "analyze | summarize | extract | compare | search | translate"
}
```

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `input_type` | Sí | Qué tipo de input envía el usuario |
| `content` | Sí | Texto plano o string base64 (máx ~27M chars para 20MB) |
| `mime_type` | No | Tipo MIME del archivo subido (ej: `application/pdf`, `image/png`) |
| `filename` | No | Nombre original del archivo (para metadata) |
| `instructions` | Sí | Lo que el usuario quiere que se haga con el input (1-5000 chars) |
| `mode` | Sí | Modo de procesamiento sugerido por la UI |

**Enrutamiento automático:**
- `text` → `glm-4.7-flash` (chat)
- `image_base64` → `llama-3.2-11b-vision-instruct` (vision)
- `document_base64` con `image/*` → vision (PDF ya convertido por la webapp)
- `document_base64` con tipo texto → decodifica y procesa como texto
- `document_base64` binario grande → vision como fallback

**Respuesta `data`:**
```json
{
  "response": "El contrato contiene 3 cláusulas de penalización...",
  "input_length": 45230,
  "mode": "extract"
}
```

---

### 1. `social_search` — Búsqueda de perfiles RRSS/Web

```json
{
  "query": "María García ingeniera software",
  "platforms": ["linkedin", "github"],
  "max_results": 10
}
```

**Flujo:** Brave Search → fallback Serper → normalización con `glm-4.7-flash`.

**Respuesta `data`:**
```json
{
  "profiles": [
    {
      "name": "María García",
      "url": "https://linkedin.com/in/mariagarcia",
      "platform": "linkedin",
      "snippet": "Senior Software Engineer at TechCorp",
      "confidence": 0.92
    }
  ],
  "total_found": 5,
  "source_api_used": "brave"
}
```

---

### 2. `semantic_matcher` — Comparación semántica de documentos

```json
{
  "documents": [
    { "id": "contrato", "content": "Este acuerdo termina el 31 de diciembre..." },
    { "id": "email", "content": "Tenga en cuenta que el contrato vence el 15 de enero..." }
  ]
}
```

**Flujo:** Embeddings (`qwen3-embedding-0.6b`) → cosine similarity → análisis cualitativo con `glm-4.7-flash`.

---

### 3. `data_extractor` — Extracción de URL, imágenes y documentos

```json
{
  "type": "url | image_base64 | document_base64",
  "source": "https://ejemplo.com o base64...",
  "extract_mode": "metadata | text | structured",
  "mime_type": "application/pdf",
  "filename": "factura.pdf"
}
```

**Ahora soporta `document_base64`** además de URL e imagen. Los documentos de texto (`.txt`, `.csv`, `.html`, `.md`) se decodifican y procesan con el modelo de chat. PDFs e imágenes van al modelo de vision.

---

### 4. `chat_with_media` — Conversación con imágenes/documentos

```json
{
  "images": [
    { "base64": "iVBOR...", "name": "grafico.png" },
    { "base64": "/9j/4AAQ...", "name": "recibo.jpg" }
  ],
  "prompt": "Compara los datos de ambas imágenes",
  "context_mode": "qa | summarize | extract"
}
```

Ahora acepta hasta 10 imágenes/documentos por request.

---

## Formato de salida (`output_format`)

**Campo nuevo en la request:** `output_format`

```json
{
  "task": "process",
  "payload": { ... },
  "output_format": "json | txt | both"
}
```

### `"json"` (por defecto)
Devuelve los datos estructurados en `data`. Ideal para consumo programático.

```json
{
  "success": true,
  "data": { "response": "...", "mode": "extract" },
  "meta": { "output_format": "json", ... }
}
```

### `"txt"`
Normaliza la salida con `glm-4.7-flash` a texto plano legible. El campo `text_output` contiene el contenido descargable como `.txt`.

```json
{
  "success": true,
  "data": { "summary": "Output for task — see text_output field" },
  "text_output": "=== REPORTE DE ANÁLISIS ===\n\nEl contrato analizado contiene...",
  "meta": { "output_format": "txt", ... }
}
```

### `"both"`
Incluye tanto `data` (JSON estructurado) como `text_output` (texto plano para descarga).

```json
{
  "success": true,
  "data": { "response": "...", "profiles": [...] },
  "text_output": "=== RESULTADOS DE BÚSQUEDA ===\n\n• María García — LinkedIn...",
  "meta": { "output_format": "both", ... }
}
```

---

## API Reference

### `GET /status`

Sin autenticación. Devuelve estado del Worker, tareas, modelos y límites.

### `POST /`

Requiere `Authorization: Bearer <API_KEY>`.

**Request completa:**
```json
{
  "task": "process | social_search | semantic_matcher | data_extractor | chat_with_media",
  "payload": { ... },
  "output_format": "json | txt | both",
  "context_id": "opcional-id-para-la-webapp"
}
```

**Response (éxito):**
```json
{
  "success": true,
  "data": { ... },
  "text_output": "Solo si output_format es txt o both",
  "meta": {
    "request_id": "arw-m5k2j8a1-c4d1",
    "timestamp": "2024-11-27T12:00:00.000Z",
    "model_used": "@cf/zai-org/glm-4.7-flash",
    "latency_ms": 1450,
    "output_format": "both",
    "attempts": 1
  }
}
```

**Response (error):**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "instructions must be a non-empty string"
  },
  "meta": {
    "request_id": "arw-m5k2j8a1-c4d1",
    "timestamp": "2024-11-27T12:00:00.000Z"
  }
}
```

---

## Ejemplos curl

### Procesar texto del usuario (tarea principal)

```bash
curl -X POST https://auror-research-worker.SUBDOMAIN.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu-api-key" \
  -d '{
    "task": "process",
    "payload": {
      "input_type": "text",
      "content": "El siguiente contrato establece que las partes acuerdan una penalización del 15% en caso de incumplimiento...",
      "instructions": "Identifica todas las cláusulas de penalización y sus condiciones",
      "mode": "extract"
    },
    "output_format": "both"
  }'
```

### Subir un documento (PDF ya convertido a imagen por la webapp)

```bash
BASE64=$(base64 -i documento_convertido.png)

curl -X POST https://auror-research-worker.SUBDOMAIN.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu-api-key" \
  -d "{
    \"task\": \"process\",
    \"payload\": {
      \"input_type\": \"document_base64\",
      \"content\": \"$BASE64\",
      \"mime_type\": \"image/png\",
      \"filename\": \"contrato_pagina1.png\",
      \"instructions\": \"Extrae todas las fechas y montos del documento\",
      \"mode\": \"extract\"
    },
    \"output_format\": \"txt\"
  }"
```

### Búsqueda social

```bash
curl -X POST https://auror-research-worker.SUBDOMAIN.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu-api-key" \
  -d '{
    "task": "social_search",
    "payload": {
      "query": "Carlos Pérez diseñador",
      "platforms": ["linkedin", "twitter"],
      "max_results": 10
    },
    "output_format": "both"
  }'
```

### Extracción de datos de imagen

```bash
BASE64=$(base64 -i factura.jpg)

curl -X POST https://auror-research-worker.SUBDOMAIN.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu-api-key" \
  -d "{
    \"task\": \"data_extractor\",
    \"payload\": {
      \"type\": \"image_base64\",
      \"source\": \"$BASE64\",
      \"extract_mode\": \"structured\"
    },
    \"output_format\": \"json\"
  }"
```

---

## Límites del plan free

| Recurso | Límite |
|---------|--------|
| Tamaño máximo de archivo subido | 20 MB |
| Búsquedas diarias (social_search) | 2,000 |
| Requests de vision (imágenes/documentos) | 10,000 |
| Documentos por semantic_matcher | 3 |
| Resultados por social_search | 20 |
| Imágenes por chat_with_media | 10 |
| Longitud máxima de texto | 500,000 chars |
| Timeout de request | 30 segundos |
| Formatos de salida | json, txt, both |

---

## Guía de integración con la webapp Auror

### Flujo completo de input del usuario

```typescript
// ─── 1. Capturar input del usuario ────────────────────────────────────

interface UserInput {
  type: "text" | "file";
  content: string | File;
  instructions: string;
  mode: "analyze" | "summarize" | "extract" | "compare" | "search" | "translate";
  outputFormat: "json" | "txt" | "both";
}

// ─── 2. Preparar el payload para el Worker ────────────────────────────

async function preparePayload(input: UserInput): Promise<{
  task: string;
  payload: Record<string, unknown>;
  output_format: string;
}> {
  if (input.type === "text") {
    return {
      task: "process",
      payload: {
        input_type: "text",
        content: input.content as string,
        instructions: input.instructions,
        mode: input.mode,
      },
      output_format: input.outputFormat,
    };
  }

  // Es un archivo
  const file = input.content as File;

  // PDFs → convertir a imágenes en el cliente
  if (file.type === "application/pdf") {
    const images = await pdfToImages(file);
    // Si son múltiples páginas, usar chat_with_media o process con la primera
    if (images.length === 1) {
      return {
        task: "process",
        payload: {
          input_type: "document_base64",
          content: images[0],
          mime_type: "image/png",
          filename: file.name,
          instructions: input.instructions,
          mode: input.mode,
        },
        output_format: input.outputFormat,
      };
    }
    // Múltiples páginas → chat_with_media
    return {
      task: "chat_with_media",
      payload: {
        images: images.map((b64, i) => ({
          base64: b64,
          name: `${file.name}_pag${i + 1}.png`,
        })),
        prompt: input.instructions,
        context_mode: input.mode === "extract" ? "extract" : input.mode === "summarize" ? "summarize" : "qa",
      },
      output_format: input.outputFormat,
    };
  }

  // Imágenes → base64 directo
  if (file.type.startsWith("image/")) {
    const base64 = await fileToBase64(file);
    return {
      task: "process",
      payload: {
        input_type: "image_base64",
        content: base64,
        mime_type: file.type,
        filename: file.name,
        instructions: input.instructions,
        mode: input.mode,
      },
      output_format: input.outputFormat,
    };
  }

  // Otros documentos → base64
  const base64 = await fileToBase64(file);
  return {
    task: "process",
    payload: {
      input_type: "document_base64",
      content: base64,
      mime_type: file.type,
      filename: file.name,
      instructions: input.instructions,
      mode: input.mode,
    },
    output_format: input.outputFormat,
  };
}

// ─── 3. Enviar al Worker y manejar la respuesta ──────────────────────

async function callAurorWorker(payload: {
  task: string;
  payload: Record<string, unknown>;
  output_format: string;
}): Promise<AurorResponse> {
  const WORKER_URL = "https://auror-research-worker.SUBDOMAIN.workers.dev";
  const API_KEY = localStorage.getItem("auror_api_key") ?? "";

  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  return await response.json();
}

// ─── 4. Mostrar resultado + opción de descarga ───────────────────────

function handleResponse(result: AurorResponse) {
  if (!result.success) {
    showError(result.error.message);
    return;
  }

  // Mostrar resultado en la UI
  if (result.meta.output_format === "json") {
    displayJSON(result.data);
  } else if (result.meta.output_format === "txt") {
    displayText(result.text_output!);
  } else {
    // "both" — mostrar JSON + botón descarga .txt
    displayJSON(result.data);
    addDownloadButton("Descargar .txt", result.text_output!, "resultado.txt");
  }

  // Siempre ofrecer descarga del JSON completo
  addDownloadButton(
    "Descargar .json",
    JSON.stringify(result, null, 2),
    `auror_${result.meta.request_id}.json`
  );

  // Guardar en historial para dashboard
  saveToHistory(result);
}

// ─── 5. Funciones auxiliares ──────────────────────────────────────────

async function pdfToImages(file: File): Promise<string[]> {
  // Usar pdf.js para convertir PDF → imágenes en el cliente
  const pdfjsLib = (window as any).pdfjsLib;
  const pdf = await pdfjsLib.getDocument(await file.arrayBuffer()).promise;
  const images: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    // Base64 sin el prefijo data:...
    images.push(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
  }
  return images;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Sin prefijo data:...
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function addDownloadButton(label: string, content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.textContent = label;
  document.getElementById("downloads")!.appendChild(a);
}

function saveToHistory(result: AurorSuccessResponse) {
  const history = JSON.parse(localStorage.getItem("auror_history") ?? "[]");
  history.push({
    request_id: result.meta.request_id,
    timestamp: result.meta.timestamp,
    task: "unknown", // track this from the original request
    model_used: result.meta.model_used,
    latency_ms: result.meta.latency_ms,
    output_format: result.meta.output_format,
  });
  if (history.length > 1000) history.splice(0, history.length - 1000);
  localStorage.setItem("auror_history", JSON.stringify(history));
}

// ─── 6. Instrucciones al usuario en la UI ─────────────────────────────

const USER_INSTRUCTIONS = {
  text: {
    placeholder: "Pega o escribe el texto que quieres analizar...",
    help: "Puedes escribir cualquier texto: contratos, artículos, correos, código. Elige qué quieres hacer con él.",
  },
  file: {
    accepted: ".pdf, .docx, .txt, .csv, .png, .jpg, .webp (máximo 20 MB)",
    help: "Los PDFs se convierten a imágenes automáticamente. Para mejores resultados con documentos escaneados, usa el modo 'Extraer'.",
  },
  modes: {
    analyze: "Análisis profundo del contenido — identifica temas, entidades y patrones",
    summarize: "Resumen conciso pero completo del contenido",
    extract: "Extrae datos estructurados — ideal para facturas, contratos, formularios",
    compare: "Compara y contrasta puntos clave del contenido",
    search: "Identifica temas principales y sugiere búsquedas relevantes",
    translate: "Traduce el contenido a otro idioma (especifica cuál en instrucciones)",
  },
  outputFormats: {
    json: "Datos estructurados para uso programático",
    txt: "Texto plano legible para lectura y descarga",
    both: "Ambos formatos — JSON para la app + .txt para ti",
  },
};
```

---

## Estructura del proyecto

```
auror-research-worker/
├── src/
│   └── index.ts          # Worker completo (5 tareas, output_format, normalización)
├── wrangler.toml          # Config con [ai] binding
├── tsconfig.json          # TypeScript para Workers
├── package.json           # Dependencias mínimas
└── README.md              # Este archivo
```

---

## Despliegue

### 1. Instalar dependencias

```bash
cd auror-research-worker
npm install
```

### 2. Configurar secrets

**NUNCA pongas secrets en el código.** Usa Cloudflare Dashboard o `wrangler secret`:

```bash
wrangler secret put API_KEY
# → Ingresa tu API key (ej: auror_sk_a1b2c3d4e5f6)

wrangler secret put ALLOWED_ORIGINS
# → Orígenes permitidos separados por coma (ej: https://auror.app,https://dev.auror.app)

wrangler secret put BRAVE_API_KEY
# → Key de Brave Search API (https://brave.com/search/api/)

wrangler secret put SERPER_API_KEY
# → Key de Serper.dev (https://serper.dev/)
```

**Alternativa via Cloudflare Dashboard:**
1. **Workers & Pages** → Selecciona `auror-research-worker`
2. **Settings** → **Variables and Secrets**
3. Agrega cada secret como tipo **Encrypt**

### 3. Deploy

```bash
npm run deploy
```

### 4. Verificar

```bash
# Status (sin auth)
curl https://auror-research-worker.SUBDOMAIN.workers.dev/status

# Procesar texto (con auth)
curl -X POST https://auror-research-worker.SUBDOMAIN.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer auror_sk_tu_key" \
  -d '{
    "task": "process",
    "payload": {
      "input_type": "text",
      "content": "Hola mundo, esto es una prueba del sistema Auror.",
      "instructions": "Analiza este texto",
      "mode": "analyze"
    },
    "output_format": "both"
  }'
```

---

## Códigos de error

| Código | Descripción |
|--------|-------------|
| `UNAUTHORIZED` | Token Bearer inválido o faltante |
| `METHOD_NOT_ALLOWED` | Solo POST y GET /status |
| `INVALID_JSON` | Body JSON malformado |
| `VALIDATION_ERROR` | Campo del payload inválido |
| `UNKNOWN_TASK` | Task no reconocido |
| `SEARCH_API_UNAVAILABLE` | Brave y Serper fallaron |
| `EMBEDDING_FAILED` | Error generando embeddings |
| `URL_FETCH_FAILED` | No se pudo acceder a la URL |
| `VISION_FAILED` | Error en el modelo de vision |
| `TASK_FAILED` | Error genérico en la tarea |

---

## Modelos usados

| Modelo | Tarea(s) | Propósito |
|--------|----------|-----------|
| `@cf/zai-org/glm-4.7-flash` | process (texto), social_search, semantic_matcher, data_extractor (URL), **normalización de salida** | Chat, JSON, análisis, formateo .txt |
| `@cf/qwen/qwen3-embedding-0.6b` | semantic_matcher | Embeddings para similitud coseno |
| `@cf/meta/llama-3.2-11b-vision-instruct` | process (imagen/doc), data_extractor (imagen/doc), chat_with_media | OCR, vision, multi-imagen |

---

## Seguridad

- **API_KEY**: Se valida en cada POST con `Authorization: Bearer <key>`. Sin key → 401.
- **CORS**: Se compara `Origin` contra `ALLOWED_ORIGINS`. Solo orígenes coincidentes reciben header CORS.
- **Sin secrets en código**: Todo va en Cloudflare Secrets (encriptado).
- **Sin filesystem**: No usa `fs`, `window`, ni `document`. V8 isolate puro.
- **Timeouts**: Todo `fetch()` externo usa `AbortSignal.timeout(30000)`.
- **Validación estricta**: Todos los campos del payload se validan antes de procesar.
- **Sanitización**: Longitudes de string limitadas, arrays acotados.

---

## Licencia

Privada — Plataforma Auror
