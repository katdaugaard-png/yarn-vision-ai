import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ---------- Sikkerheds-grænser ----------
const ALLOWED_ORIGIN_SUFFIXES = [
  "daugaardgarn.dk",
  "lovable.app",
  "lovableproject.com",
  "localhost",
  "127.0.0.1",
];
const PER_IP_HOURLY_LIMIT = 20;
const GLOBAL_DAILY_LIMIT = 500;
const BUCKET = "recolored";
const FEED_URL =
  "https://daugaardgarn.dk/collections/alle-kits/products.json?limit=250";

// ---------- Hjælpere ----------
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

type FeedKit = {
  id: string;
  mainImage: string;
  colors: Map<string, { name: string; swatchImage: string }>;
};

async function loadKit(kitId: string): Promise<FeedKit | null> {
  const res = await fetch(FEED_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    products: Array<{
      id: number;
      images: Array<{ src: string; position: number }>;
      variants: Array<{
        option1: string | null;
        featured_image?: { src: string } | null;
      }>;
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
    const id = name.toLowerCase().replace(/\s+/g, "-");
    if (!colors.has(id)) colors.set(id, { name, swatchImage: swatch });
  }
  return { id: kitId, mainImage, colors };
}

async function fetchAsBase64(
  url: string,
): Promise<{ data: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { data: btoa(bin), mime };
}

function publicUrl(path: string): string {
  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---------- Route ----------
export const Route = createFileRoute("/api/recolor")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1) Origin allowlist
        if (!originAllowed(request)) {
          return Response.json({ error: "Forbidden origin" }, { status: 403 });
        }

        // 2) Validér input
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

        const cacheKey = `${kitId}__${colorId}.png`;

        // 3) Cache hit? Returnér med det samme — ingen rate-limit, ingen AI-kald.
        const existing = await supabaseAdmin.storage
          .from(BUCKET)
          .list("", { search: cacheKey, limit: 1 });
        if (existing.data?.some((f) => f.name === cacheKey)) {
          // log som cache hit (best effort)
          const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
          await supabaseAdmin
            .from("recolor_requests")
            .insert({ ip, kit_id: kitId, color_id: colorId, cache_hit: true });
          return Response.json({ imageUrl: publicUrl(cacheKey), cached: true });
        }

        // 4) Rate limit pr. IP (sidste time)
        const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count: ipCount } = await supabaseAdmin
          .from("recolor_requests")
          .select("id", { count: "exact", head: true })
          .eq("ip", ip)
          .eq("cache_hit", false)
          .gte("created_at", hourAgo);
        if ((ipCount ?? 0) >= PER_IP_HOURLY_LIMIT) {
          return Response.json(
            { error: "Du har genereret mange billeder. Prøv igen om en time." },
            { status: 429 },
          );
        }

        // 5) Globalt dagligt budget
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: dayCount } = await supabaseAdmin
          .from("recolor_requests")
          .select("id", { count: "exact", head: true })
          .eq("cache_hit", false)
          .gte("created_at", dayAgo);
        if ((dayCount ?? 0) >= GLOBAL_DAILY_LIMIT) {
          return Response.json(
            { error: "Dagens AI-kvote er brugt op. Prøv igen i morgen." },
            { status: 429 },
          );
        }

        // 6) Allowlist-validering mod Shopify-feedet
        const kit = await loadKit(kitId);
        if (!kit) {
          return Response.json({ error: "Ukendt kit" }, { status: 404 });
        }
        const color = kit.colors.get(colorId);
        if (!color) {
          return Response.json({ error: "Ukendt farve" }, { status: 404 });
        }

        // 7) Hent billederne server-side (klienten sender ALDRIG billed-data)
        const [garmentImage, yarnImage] = await Promise.all([
          fetchAsBase64(kit.mainImage),
          fetchAsBase64(color.swatchImage),
        ]);

        // 8) Kald Google Gemini direkte (eget kort, ikke Lovable Gateway)
        const key = process.env.GEMINI_API_KEY;
        if (!key) {
          return Response.json({ error: "AI ikke konfigureret" }, { status: 500 });
        }

        const promptText = `You are a fashion product photo editor for a yarn webshop.
The FIRST image is a finished KNITTED garment (sweater, vest or hat) photographed on a model or flat-lay.
The SECOND image is a skein of yarn — use ONLY its color as the new color reference for the knitted piece.
Target color name: ${color.name}.

STRICT RULES — recolor ONLY the knitted garment itself:
- DO change: only the main yarn color of the knitted sweater/vest/hat.
- DO NOT change: the model, skin, hair, face, hands, pose, background, lighting, shadows.
- DO NOT change: any shirt, blouse, t-shirt, trousers, jewellery or other clothing worn UNDER or NEXT TO the knitted piece — these must keep their original colors exactly.
- PRESERVE: the knitted stitch structure, cables, ribbing and any multi-color pattern. For multi-color patterns, only shift the dominant base color; contrast/pattern colors stay recognizable.
- Keep the same framing and crop as the input image. Do not zoom in or crop tighter.

Output a single photorealistic image, same composition as the input.`;

        const upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: promptText },
                    { inline_data: { mime_type: garmentImage.mime, data: garmentImage.data } },
                    { inline_data: { mime_type: yarnImage.mime, data: yarnImage.data } },
                  ],
                },
              ],
              generationConfig: { responseModalities: ["IMAGE"] },
            }),
          },
        );

        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => "");
          console.error("Gemini error", upstream.status, errText);
          if (upstream.status === 429) {
            return Response.json(
              { error: "AI-tjenesten er overbelastet, prøv igen om lidt." },
              { status: 429 },
            );
          }
          if (upstream.status === 402 || upstream.status === 403) {
            return Response.json(
              { error: "AI-konto fejl (tjek Google-billing)." },
              { status: 402 },
            );
          }
          return Response.json({ error: "AI-fejl" }, { status: 502 });
        }

        const aiJson = (await upstream.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inline_data?: { data?: string; mime_type?: string };
                inlineData?: { data?: string; mimeType?: string };
              }>;
            };
          }>;
        };
        const parts = aiJson.candidates?.[0]?.content?.parts ?? [];
        const imgPart = parts.find(
          (p) => p.inline_data?.data || p.inlineData?.data,
        );
        const base64 =
          imgPart?.inline_data?.data ?? imgPart?.inlineData?.data;
        if (!base64) {
          console.error("Unexpected Gemini response", JSON.stringify(aiJson).slice(0, 500));
          return Response.json({ error: "Tomt AI-svar" }, { status: 502 });
        }

        // 9) Gem i cache
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const upload = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(cacheKey, bytes, {
            contentType: "image/png",
            upsert: true,
          });
        if (upload.error) {
          console.error("Storage upload error", upload.error);
        }

        // 10) Log forbrug
        await supabaseAdmin
          .from("recolor_requests")
          .insert({ ip, kit_id: kitId, color_id: colorId, cache_hit: false });

        return Response.json({
          imageUrl: publicUrl(cacheKey),
          cached: false,
        });
      },
    },
  },
});
