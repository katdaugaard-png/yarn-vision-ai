import { createFileRoute } from "@tanstack/react-router";

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
  tags: string[];
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
            headers: { Accept: "application/json" },
          });
          if (!res.ok) {
            return Response.json(
              { error: `Shopify feed: ${res.status}` },
              { status: 502 },
            );
          }
          const data = (await res.json()) as { products: ShopifyProduct[] };

          const kits: NormalizedKit[] = data.products
            .map((p) => {
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
                id: name.toLowerCase().replace(/\s+/g, "-"),
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
