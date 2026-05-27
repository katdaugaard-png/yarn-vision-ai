import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KitViewer, type Kit } from "@/components/KitViewer";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";

export const Route = createFileRoute("/shop")({
  component: ShopPage,
  head: () => ({
    meta: [
      { title: "Kunde-demo — AI Garn-farveskift" },
      {
        name: "description",
        content:
          "Demo af kundeoplevelsen: vælg et kit og klik på en garnnøgle for at se trøjen i den farve.",
      },
    ],
  }),
});

function ShopPage() {
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Kit | null>(null);

  useEffect(() => {
    fetch("/api/shopify-kits")
      .then((r) => r.json())
      .then((data: { kits?: Kit[]; error?: string }) => {
        if (data.error || !data.kits) throw new Error(data.error || "Tom feed");
        setKits(data.kits);
      })
      .catch(() => setError("Kunne ikke hente kits fra Daugaard Garn lige nu."));
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <h1 className="text-xl font-semibold">Strikkekit — Kunde-demo</h1>
          <p className="text-xs text-muted-foreground">
            Sådan vil widgetten se ud på din Shopify produktside
          </p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {selected ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(null)}
              className="mb-4 -ml-2"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Tilbage til kits
            </Button>
            <KitViewer kit={selected} />
          </>
        ) : error ? (
          <p className="text-sm text-destructive py-8 text-center">{error}</p>
        ) : !kits ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Henter kits…
          </div>
        ) : kits.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Ingen kits fundet.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {kits.map((kit) => (
              <button
                key={kit.id}
                type="button"
                onClick={() => setSelected(kit)}
                className="group text-left rounded-xl overflow-hidden border bg-card hover:shadow-md hover:border-primary/50 transition-all"
              >
                <div className="aspect-square bg-muted overflow-hidden">
                  <img
                    src={kit.mainImage}
                    alt={kit.name}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
                <div className="p-3">
                  <p className="font-medium text-sm leading-tight line-clamp-2">
                    {kit.name}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {kit.colors.length} farver
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
