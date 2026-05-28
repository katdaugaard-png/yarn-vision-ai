import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export type YarnColor = {
  id: string;
  name: string;
  /** Billede af garnnøglen — bruges både som swatch og som farve-reference til AI. */
  swatchImage: string;
};

export type Kit = {
  id: string;
  handle?: string;
  name: string;
  description?: string;
  /** Hovedbillede i original-farven. */
  mainImage: string;
  /** Original-farve vises altid først som "ægte" foto. */
  originalColorName: string;
  colors: YarnColor[];
};

type Props = {
  kit: Kit;
};

export function KitViewer({ kit }: Props) {
  const [activeColorId, setActiveColorId] = useState<string | null>(null);
  const [displayImage, setDisplayImage] = useState(kit.mainImage);
  const [isFinal, setIsFinal] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cache per session: kitId+colorId -> dataUrl
  const cacheRef = useRef<Map<string, string>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  // Reset hvis kit skifter
  useEffect(() => {
    setActiveColorId(null);
    setDisplayImage(kit.mainImage);
    setIsFinal(true);
    setError(null);
    cacheRef.current.clear();
    abortRef.current?.abort();
  }, [kit.id, kit.mainImage]);

  const selectOriginal = () => {
    abortRef.current?.abort();
    setActiveColorId(null);
    setDisplayImage(kit.mainImage);
    setIsFinal(true);
    setError(null);
    setLoading(false);
  };

  const selectColor = async (color: YarnColor) => {
    if (activeColorId === color.id && !loading) return;
    abortRef.current?.abort();
    setActiveColorId(color.id);
    setError(null);

    const cacheKey = `${kit.id}:${color.id}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setDisplayImage(cached);
      setIsFinal(true);
      setLoading(false);
      return;
    }

    setLoading(true);
    setIsFinal(false);
    setDisplayImage(kit.mainImage);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/recolor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kitId: kit.id, colorId: color.id }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        imageUrl?: string;
        error?: string;
        _debug?: unknown;
      };
      if (!res.ok || !data.imageUrl) {
        console.error("[recolor] backend error", {
          status: res.status,
          error: data.error,
          debug: data._debug,
          kitId: kit.id,
          colorId: color.id,
        });
        throw new Error(data.error || `Generering fejlede (HTTP ${res.status})`);
      }
      const nextImage = new Image();
      nextImage.decoding = "async";
      nextImage.onload = () => {
        setDisplayImage(data.imageUrl!);
        setIsFinal(true);
      };
      nextImage.onerror = () => {
        setDisplayImage(data.imageUrl!);
        setIsFinal(true);
      };
      nextImage.src = data.imageUrl;
      cacheRef.current.set(cacheKey, data.imageUrl);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Kunne ikke generere — prøv igen.");
      setDisplayImage(kit.mainImage);
      setIsFinal(true);
      setActiveColorId(null);
    } finally {
      if (abortRef.current === ctrl) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="relative w-full overflow-hidden rounded-2xl border bg-muted flex items-center justify-center" style={{ minHeight: "20rem" }}>
        <img
          src={displayImage}
          alt={kit.name}
          loading="eager"
          className={cn(
            "max-h-[55vh] w-full object-contain transition-[filter,opacity] duration-500",
            isFinal ? "blur-0" : "blur-xl",
          )}
          onLoad={() => setIsFinal(true)}
          onError={() => {
            setDisplayImage(kit.mainImage);
            setIsFinal(true);
            setLoading(false);
            setActiveColorId(null);
            setError("Kunne ikke vise forhåndsvisningen — prøv igen.");
          }}
        />
        {loading && (
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-center p-4 pointer-events-none">
            <div className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-sm shadow">
              <Loader2 className="h-4 w-4 animate-spin" />
              Genererer AI-forhåndsvisning…
            </div>
          </div>
        )}
        {activeColorId && (
          <div className="absolute top-3 left-3 rounded-full bg-background/90 px-3 py-1 text-xs font-medium shadow">
            AI-forhåndsvisning · farven kan variere
          </div>
        )}
      </div>

      <div className="mt-6">
        <h2 className="text-2xl font-semibold">{kit.name}</h2>
        {kit.description && (
          <p className="text-muted-foreground mt-1">{kit.description}</p>
        )}
      </div>

      <div className="mt-5">
        <p className="text-sm font-medium mb-3">
          Vælg farve:{" "}
          <span className="text-muted-foreground">
            {activeColorId
              ? kit.colors.find((c) => c.id === activeColorId)?.name
              : kit.originalColorName + " (original)"}
          </span>
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={selectOriginal}
            className={cn(
              "relative h-[4.75rem] w-[4.75rem] overflow-hidden rounded-full border bg-card shadow-sm transition-all",
              activeColorId === null
                ? "border-primary ring-2 ring-primary/25 scale-105"
                : "border-border hover:border-foreground/25 hover:shadow",
            )}
            title={`${kit.originalColorName} (original)`}
            aria-label={`${kit.originalColorName} (original)`}
          >
            <span className="absolute inset-[3px] overflow-hidden rounded-full bg-muted">
              <img src={kit.mainImage} alt="" className="h-full w-full object-cover" />
            </span>
          </button>
          {kit.colors.map((c) => {
            const active = activeColorId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => selectColor(c)}
                disabled={loading && active}
                className={cn(
                  "group relative h-[5.25rem] w-[5.25rem] overflow-hidden rounded-full border bg-card shadow-sm transition-all",
                  active
                    ? "border-primary ring-2 ring-primary/25 scale-105"
                    : "border-border hover:border-foreground/25 hover:shadow",
                )}
                title={c.name}
                aria-label={c.name}
              >
                <span className="absolute inset-[4px] flex items-center justify-center overflow-hidden rounded-full bg-muted/70">
                  <img
                    src={c.swatchImage}
                    alt=""
                    className="h-full w-full scale-[1.28] object-cover drop-shadow-sm transition-transform duration-200 group-hover:scale-[1.34]"
                  />
                </span>
                {loading && active && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Farvevisninger er AI-genererede forhåndsvisninger — en service fra Daugaard Garn.
          Den endelige garnfarve kan variere let fra skærmens visning.
        </p>
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
  );
}
