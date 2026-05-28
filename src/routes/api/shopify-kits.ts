import { createFileRoute } from "@tanstack/react-router";
import { toShopifyOptionId } from "@/lib/shopify-identifiers";

/**
 * Henter kits fra Daugaard Garns offentlige Shopify-feed og normaliserer
 * dem til det format KitViewer bruger. Proxy gennem vores server route
 * for at undgå eventuelle CORS-problemer og kunne cache senere.
 */

type ShopifyVariant = {
  id: number;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  available: boolean;
  featured_image?: { src: string; alt?: string | null } | null;
};

type ShopifyImage = { src: string; position: number };

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  product_type: string;
  tags: string[] | string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
};

type NormalizedKit = {
  id: string;
  handle: string;
  name: string;
  mainImage: string;
  originalColorName: string;
  colors: { id: string; name: string; swatchImage: string }[];
};

const FEED_URL =
  "https://daugaardgarn.dk/collections/alle-kits/products.json?limit=250";

export const Route = createFileRoute("/api/shopify-kits")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const res = await fetch(FEED_URL, {
            headers: {
              Accept: "application/json",
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept-Language": "da,en;q=0.9",
            },
          });
          if (!res.ok) {
            return Response.json(
              { error: `Shopify feed: ${res.status}` },
              { status: 502 },
            );
          }
          const data = (await res.json()) as { products: ShopifyProduct[] };

          const EXCLUDED_TAGS = new Set([
            "no-ai-colour-preview",
            "flerfarvet-kit",
            "multi-color-kit",
          ]);

          const kits: NormalizedKit[] = data.products
            .map((p) => {
              const rawTags = Array.isArray(p.tags)
                ? p.tags
                : typeof p.tags === "string"
                  ? p.tags.split(",")
                  : [];
              const tags = rawTags.map((t: string) =>
                String(t).trim().toLowerCase(),
              );
              if (tags.some((t) => EXCLUDED_TAGS.has(t))) return null;
              const sortedImages = [...p.images].sort(
                (a, b) => a.position - b.position,
              );
              const mainImage = sortedImages[0]?.src;
              if (!mainImage) return null;

              // Unikke farver fra option1 — bevar rækkefølge
              const seen = new Map<
                string,
                { name: string; swatchImage: string }
              >();
              for (const v of p.variants) {
                const name = v.option1?.trim();
                if (!name) continue;
                if (seen.has(name)) continue;
                const swatch = v.featured_image?.src;
                if (!swatch) continue;
                // Spring originalfarven over hvis dens swatch er præcis hovedbilledet
                seen.set(name, { name, swatchImage: swatch });
              }

              const colors = Array.from(seen.entries()).map(([name, c]) => ({
                id: toShopifyOptionId(name),
                name: c.name,
                swatchImage: c.swatchImage,
              }));

              if (colors.length < 2) return null;

              return {
                id: String(p.id),
                handle: p.handle,
                name: p.title,
                mainImage,
                originalColorName: colors[0].name,
                colors,
              } satisfies NormalizedKit;
            })
            .filter((k): k is NormalizedKit => k !== null);

          return Response.json(
            { kits },
            {
              headers: {
                "Cache-Control":
                  "public, max-age=300, stale-while-revalidate=3600",
              },
            },
          );
        } catch (e) {
          console.error("shopify-kits error", e);
          return Response.json(
            { error: "Kunne ikke hente kits" },
            { status: 500 },
          );
        }
      },
    },
  },
});
