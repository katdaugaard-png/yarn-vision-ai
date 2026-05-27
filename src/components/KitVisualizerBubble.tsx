import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowLeft, Loader2, Palette } from "lucide-react";
import { KitViewer, type Kit } from "@/components/KitViewer";
import { cn } from "@/lib/utils";

export function KitVisualizerBubble() {
  const [open, setOpen] = useState(false);
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKit, setSelectedKit] = useState<Kit | null>(null);

  useEffect(() => {
    if (!open || kits || loading) return;
    setLoading(true);
    setError(null);
    fetch("/api/shopify-kits")
      .then((r) => r.json())
      .then((data: { kits?: Kit[]; error?: string }) => {
        if (data.error || !data.kits) throw new Error(data.error || "Tom feed");
        setKits(data.kits);
      })
      .catch(() => setError("Kunne ikke hente kits lige nu."))
      .finally(() => setLoading(false));
  }, [open, kits, loading]);

  return (
    <>
      {/* Floating bubble */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full",
          "bg-primary text-primary-foreground px-4 py-3 shadow-lg",
          "hover:scale-105 hover:shadow-xl transition-all duration-200",
          "ring-2 ring-primary/20",
        )}
        aria-label="Åbn farvevælger"
      >
        <Palette className="h-5 w-5" />
        <span className="hidden sm:inline text-sm font-medium">
          Se kit i andre farver
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0 bg-background">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-xl font-serif">
              <Sparkles className="h-5 w-5 text-primary" />
              {selectedKit ? selectedKit.name : "Se dit kit i andre farver"}
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {selectedKit
                ? "Vælg en garnfarve nedenfor — AI viser dig hvordan kittet kan se ud."
                : "Vælg et kit fra Daugaard Garn og se det i alle vores garnfarver."}
            </p>
          </DialogHeader>

          <div className="p-6">
            {selectedKit ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedKit(null)}
                  className="mb-4 -ml-2"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Tilbage til kits
                </Button>
                <KitViewer kit={selectedKit} />
              </>
            ) : loading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Henter kits…
              </div>
            ) : error ? (
              <p className="text-sm text-destructive py-8 text-center">{error}</p>
            ) : kits && kits.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {kits.map((kit) => (
                  <button
                    key={kit.id}
                    type="button"
                    onClick={() => setSelectedKit(kit)}
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
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Ingen kits fundet.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
