import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { toShopifyOptionId } from "@/lib/shopify-identifiers";

const ALLOWED_ORIGIN_SUFFIXES = [
  "daugaardgarn.dk",
  "lovable.app",
  "lovableproject.com",
  "localhost",
  "127.0.0.1",
];
const PROD_PER_IP_HOURLY_LIMIT = 20;
const PROD_GLOBAL_DAILY_LIMIT = 500;
const PREVIEW_PER_IP_HOURLY_LIMIT = 80;
const PREVIEW_GLOBAL_DAILY_LIMIT = 2000;
const CACHE_MAX_AGE = 60 * 60 * 24 * 365;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const GEMINI_TIMEOUT_MS = 45_000;
const GEMINI_MAX_ATTEMPTS = 3;
const IS_DEV = process.env.NODE_ENV !== "production";

declare const RECOLOR_CACHE: R2Bucket | undefined;
declare const RATE_LIMIT_KV: KVNamespace | undefined;

function debugPayload(extra: Record<string, unknown>) {
  return IS_DEV ? { _debug: extra } : {};
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith("." + suffix),
    );
  } catch {
    return false;
  }
}

function getRequestHost(req: Request): string | null {
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function getRateLimits(req: Request) {
  const host = getRequestHost(req) ?? "";
  const isPreviewHost =
    host.includes("lovable.app") || host === "localhost" || host === "127.0.0.1";
  return {
    perIpHourlyLimit: isPreviewHost ? PREVIEW_PER_IP_HOURLY_LIMIT : PROD_PER_IP_HOURLY_LIMIT,
    globalDailyLimit: isPreviewHost ? PREVIEW_GLOBAL_DAILY_LIMIT : PROD_GLOBAL_DAILY_LIMIT,
  };
}

async function r2CacheGet(key: string): Promise<{ url: string } | null> {
  if (typeof RECOLOR_CACHE === "undefined") return null;
  try {
    const obj = await RECOLOR_CACHE.get(key);
    if (!obj) return null;
    return { url: `/api/recolor-image/${encodeURIComponent(key)}` };
  } catch (e) {
    console.error("[r2] cache get error", e);
    return null;
  }
}

async function r2CachePut(key: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
  if (typeof RECOLOR_CACHE === "undefined") return null;
  try {
    await RECOLOR_CACHE.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: `public, max-age=${CACHE_MAX_AGE}` },
    } );
    return `/api/recolor-image/${encodeURIComponent(key)}`;
  } catch (e) {
    console.error("[r2] cache put error", e);
    return null;
  }
}

async function kvIncrementAndCheck(kvKey: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number }> {
  if (typeof RATE_LIMIT_KV === "undefined") return { allowed: true, count: 0 };
  try {
    const raw = await RATE_LIMIT_KV.get(kvKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) return { allowed: false, count };
    const newCount = count + 1;
    await RATE_LIMIT_KV.put(String(newCount), String(newCount), { expirationTtl: Math.ceil(windowMs / 1000) });
    return { allowed: true, count: newCount };
  } catch (e) {
    console.error("[kv] rate limit error", e);
    return { allowed: true, count: 0 };
  }
}

async function kvGetCount(kvKey: string): Promise<number> {
  if (typeof RATE_LIMIT_KV === "undefined") return 0;
  try {
    const raw = await RATE_LIMIT_KV.get(kvKey);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

type FeedKit = {
  id: string;
  mainImage: string;
  colors: Map<string, { name: string; swatchImage: string }>;
};

const FEED_URL = "https://daugaardgarn.dk/collections/alle-kits/products.json?limit=250";

function withShopifyWidth(url: string, width: number ): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("cdn.shopify.com")) return url;
    parsed.pathname = parsed.pathname.replace(
      /_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|x\d+)(?=\.[a-z]+$)/i, "",
    );
    parsed.searchParams.set("width", String(width));
    return parsed.toString();
  } catch { return url; }
}

function looksLikeThumbnail(url: string): boolean {
  return /_(?:pico|icon|thumb|small|compact|medium|\d{1,3}x\d{0,3})\.[a-z]+(?:\?|$)/i.test(url);
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadKit(kitId: string): Promise<FeedKit | null> {
  const res = await fetch(FEED_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "da,en;q=0.9",
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    products: Array<{
      id: number;
      images: Array<{ src: string; position: number }>;
      variants: Array<{ option1: string | null; featured_image?: { src: string } | null }>;
    }>;
  };
  const product = data.products.find((p) => String(p.id) === kitId);
  if (!product) return null;
  const sorted = [...product.images].sort((a, b) => a.position - b.position);
  const mainImage = sorted[0]?.src;
  if (!mainImage) return null;
  const colors = new Map<string, { name: string; swatchImage: string }>();
  for (const v of product.variants) {
    const name = v.option1?.trim();
    const swatch = v.featured_image?.src;
    if (!name || !swatch) continue;
    const id = toShopifyOptionId(name);
    if (!colors.has(id)) colors.set(id, { name, swatchImage: swatch });
  }
  return { id: kitId, mainImage, colors };
}

async function fetchAsSmallBase64(url: string, maxSide: number, label: string): Promise<{ data: string; mime: string; finalUrl: string; bytes: number }> {
  const finalUrl = withShopifyWidth(url, maxSide);
  const res = await fetchWithTimeout(finalUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  }, IMAGE_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Image fetch failed for ${label} (${res.status}): ${finalUrl}`);
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  if (!mime.startsWith("image/")) throw new Error(`Non-image response for ${label} (${mime}): ${finalUrl}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`Suspiciously small image for ${label} (${buf.length}B): ${finalUrl}`);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  return { data: btoa(binary), mime, finalUrl, bytes: buf.length };
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inline_data?: { data?: string; mime_type?: string };
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
  }>;
};

function extractGeminiImage(response: GeminiResponse): { base64?: string; mimeType?: string; textSummary: string } {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inline_data?.data || part.inlineData?.data);
  return {
    base64: imagePart?.inline_data?.data ?? imagePart?.inlineData?.data,
    mimeType: imagePart?.inline_data?.mime_type ?? imagePart?.inlineData?.mimeType ?? "image/png",
    textSummary: parts.map((part) => part.text?.trim()).filter(Boolean).join(" | "),
  };
}

export const Route = createFileRoute("/api/recolor")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!originAllowed(request)) {
          return Response.json({ error: "Forbidden origin" }, { status: 403 });
        }

        let body: { kitId?: string; colorId?: string };
        try {
          body = (await request.json()) as { kitId?: string; colorId?: string };
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const kitId = String(body.kitId ?? "").trim();
        const colorId = String(body.colorId ?? "").trim();
        if (!/^[a-z0-9-]{1,80}$/i.test(kitId) || !/^[a-z0-9-]{1,80}$/i.test(colorId)) {
          return Response.json({ error: "Invalid kitId/colorId" }, { status: 400 });
        }

        const cacheKey = `${kitId}__${colorId}__v7.png`;

        const cached = await r2CacheGet(cacheKey);
        if (cached) {
          console.log("[recolor] R2 cache hit", { cacheKey });
          return Response.json({ imageUrl: cached.url, cached: true });
        }

        const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
        const rateLimits = getRateLimits(request);
        const safeIp = ip.replace(/[:.]/g, "_");
        const ipHourKey = `ip_hour_${safeIp}_${Math.floor(Date.now() / (60 * 60 * 1000))}`;
        const ipCheck = await kvIncrementAndCheck(ipHourKey, rateLimits.perIpHourlyLimit, 60 * 60 * 1000);
        if (!ipCheck.allowed) {
          return Response.json({ error: "Du har genereret mange billeder. Prøv igen om en time." }, { status: 429 });
        }

        const globalDayKey = `global_day_${Math.floor(Date.now() / (24 * 60 * 60 * 1000))}`;
        const globalCount = await kvGetCount(globalDayKey);
        if (globalCount >= rateLimits.globalDailyLimit) {
          return Response.json({ error: "Dagens AI-kvote er brugt op. Prøv igen i morgen." }, { status: 429 });
        }
        kvIncrementAndCheck(globalDayKey, rateLimits.globalDailyLimit + 1, 24 * 60 * 60 * 1000).catch(() => {});

        const kit = await loadKit(kitId);
        if (!kit) return Response.json({ error: "Ukendt kit" }, { status: 404 });
        const color = kit.colors.get(colorId);
        if (!color) {
          return Response.json({ error: "Ukendt farve", availableColorIds: Array.from(kit.colors.keys()) }, { status: 404 });
        }

        const stripSize = (u: string) =>
          u.split("?")[0].replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|x\d+)(?=\.[a-z]+$)/i, "");
        if (stripSize(kit.mainImage) === stripSize(color.swatchImage)) {
          return Response.json({ imageUrl: kit.mainImage, cached: true, original: true });
        }

        console.log("[recolor] source URLs", { kitId, colorId, mainImage: kit.mainImage, swatchImage: color.swatchImage, mainLooksThumb: looksLikeThumbnail(kit.mainImage), swatchLooksThumb: looksLikeThumbnail(color.swatchImage) });
        let garmentImage: Awaited<ReturnType<typeof fetchAsSmallBase64>>;
        let yarnImage: Awaited<ReturnType<typeof fetchAsSmallBase64>>;
        try {
          [garmentImage, yarnImage] = await Promise.all([
            fetchAsSmallBase64(kit.mainImage, 1400, "garment"),
            fetchAsSmallBase64(color.swatchImage, 768, "yarn"),
          ]);
        } catch (error) {
          return Response.json({ error: "Kunne ikke hente produktbillederne fra Shopify.", ...debugPayload({ reason: (error as Error).message }) }, { status: 422 });
        }

        const key = process.env.GEMINI_API_KEY;
        if (!key) return Response.json({ error: "AI ikke konfigureret" }, { status: 500 });

        const promptText = `You are a fashion product photo editor for a yarn webshop.
The FIRST image is a finished KNITTED garment (sweater, vest, hat or baby suit) — it may be a SINGLE photo OR a COLLAGE / GRID with multiple photos and close-ups of the SAME garment in different colors and angles.
The SECOND image is a skein of yarn — use ONLY its dominant fiber color as the new color reference for the knitted piece. Ignore the yarn label, white studio background and packaging.
Target color name: "${color.name}".

STRICT RULES — recolor ONLY the knitted garment(s):
- If the first image is a collage / grid / multi-panel layout, you MUST recolor the knitted garment in EVERY SINGLE panel — top-left, top-right, bottom-left, bottom-right, close-ups, ALL of them. This is critical even when the panels show the garment in DIFFERENT starting colors (e.g. one brown panel + three green panels) — every panel must end up the SAME new target color. Do NOT leave any panel in its original color under any circumstances.
- Replace the entire base color of every knitted garment with the EXACT dominant color sampled from the yarn skein. This is REQUIRED even if the garment already appears to be a similar shade — match the yarn's exact hue, saturation and lightness, do not keep the original tone.
- The YARN IMAGE is the source of truth for the target color. Ignore assumptions from the garment's current color or from words like blue/blå in the product name if the yarn visually looks more gray, blue-gray, dusty, muted or slate-like.
- PANEL COUNT RULE: Count the number of distinct photo panels in the input image BEFORE you start. If there are 4 panels, you MUST output exactly 4 recolored panels. If there are 3 panels, output 3. Never reduce the panel count. Verify your output has the same number of panels as the input before finishing.
- For very light, pastel, blush, pink, lyserød, off-white or pale blue yarn colors, recolor the garment clearly and visibly to that pale yarn tone — a viewer must instantly see the new color. Do NOT leave the garment in its previous color.
- For gray / grey / grå / lys grå / chambray / chambrey / havblå / blue-gray yarns, the final garment must visibly move toward a cooler, grayer, more muted tone sampled from the yarn. If the original garment already looks somewhat blue, but the yarn is grayer and duller, the result MUST become noticeably grayer and less saturated than the original.
- DO NOT change: the model, skin, hair, face, hands, pose, background, lighting, shadows, wood buttons, fur blankets or props.
- DO NOT change: any shirt, blouse, t-shirt, trousers, jewellery or other clothing worn UNDER or NEXT TO the knitted piece — keep their original colors exactly.
- PRESERVE: the knitted stitch structure, cables, ribbing and any multi-color pattern. For multi-color patterns, only shift the dominant base color; contrast/pattern colors stay recognizable.
- Keep the same framing, crop and panel layout as the input image. Do not zoom, crop tighter or rearrange panels.

Output a single photorealistic image, same composition and same number of panels as the input. Return the IMAGE only — do not return a textual description.`;

        const GEMINI_MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"];
        let base64: string | undefined;
        let generatedMime = "image/png";
        let lastErrorMessage = "";
        let lastDebug: Record<string, unknown> = {};

        for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
          const t0 = Date.now();
          const model = GEMINI_MODELS[Math.min(attempt - 1, GEMINI_MODELS.length - 1)];
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key )}`;
          console.log("[recolor] calling Gemini", { attempt, model });

          let upstream: Response;
          try {
            upstream = await fetchWithTimeout(geminiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [
                  { inlineData: { mimeType: garmentImage.mime, data: garmentImage.data } },
                  { inlineData: { mimeType: yarnImage.mime, data: yarnImage.data } },
                  { text: promptText },
                ]}],
                generationConfig: { responseModalities: ["IMAGE"], temperature: 1.0 },
                safetySettings: [
                  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ],
              }),
            }, GEMINI_TIMEOUT_MS);
          } catch (error) {
            lastErrorMessage = (error as Error).message;
            if (attempt < GEMINI_MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 400 * attempt)); continue; }
            if (lastErrorMessage === "timeout") return Response.json({ error: "Det tog for lang tid at lave denne forhåndsvisning. Prøv igen eller vælg en anden farve.", ...debugPayload({ reason: "timeout" }) }, { status: 504 });
            return Response.json({ error: "Kunne ikke nå AI-tjenesten. Prøv igen om lidt.", ...debugPayload({ reason: lastErrorMessage }) }, { status: 502 });
          }

          const elapsed = Date.now() - t0;
          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => "");
            lastErrorMessage = `HTTP ${upstream.status}: ${errText.slice(0, 800)}`;
            if (upstream.status === 400 || upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
              return Response.json({ error: upstream.status === 400 ? "AI afviste billedet. Prøv en anden farve." : "AI-konto fejl (tjek Google-billing).", ...debugPayload({ status: upstream.status }) }, { status: upstream.status === 400 ? 422 : 402 });
            }
            if (attempt < GEMINI_MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 400 * attempt)); continue; }
            if (upstream.status === 429) return Response.json({ error: "AI-tjenesten er overbelastet, prøv igen om lidt." }, { status: 429 });
            return Response.json({ error: "AI-tjenesten svarede ikke. Prøv igen.", ...debugPayload({ status: upstream.status }) }, { status: 502 });
          }

          const rawText = await upstream.text();
          let aiJson: GeminiResponse;
          try {
            aiJson = JSON.parse(rawText) as GeminiResponse;
          } catch {
            lastErrorMessage = "invalid_json";
            if (attempt < GEMINI_MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 400 * attempt)); continue; }
            return Response.json({ error: "AI gav et ugyldigt svar. Prøv igen." }, { status: 502 });
          }

          const extracted = extractGeminiImage(aiJson);
          base64 = extracted.base64;
          generatedMime = extracted.mimeType ?? generatedMime;
          lastDebug = { model, attempt, elapsedMs: elapsed, hasInlineImage: Boolean(base64) };
          console.log("[recolor] Gemini response parsed", lastDebug);
          if (base64) break;
          if (attempt < GEMINI_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }

        if (!base64) {
          return Response.json({ error: "AI returnerede ingen billede-data. Prøv igen eller vælg en anden farve.", ...debugPayload({ reason: "no_image", lastDebug }) }, { status: 502 });
        }

        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const imageUrl = await r2CachePut(cacheKey, bytes, generatedMime);
        const finalUrl = imageUrl ?? `data:${generatedMime};base64,${base64}`;

        return Response.json({ imageUrl: finalUrl, cached: false });
      },
    },
  },
});
