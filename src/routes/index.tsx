import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { streamRecolor, fileToDataUrl } from "@/lib/recolor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [garment, setGarment] = useState<string | null>(null);
  const [yarn, setYarn] = useState<string | null>(null);
  const [colorDesc, setColorDesc] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [isFinal, setIsFinal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (v: string) => void,
  ) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setter(await fileToDataUrl(f));
  };

  const run = async () => {
    if (!garment) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setIsFinal(false);
    try {
      await streamRecolor(
        {
          garmentImage: garment,
          yarnImage: yarn ?? undefined,
          colorDescription: colorDesc || undefined,
        },
        (url, final) => {
          setResult(url);
          if (final) setIsFinal(true);
        },
      );
    } catch (e: any) {
      setError(e.message ?? "Ukendt fejl");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">AI Garn-farveskift (test)</h1>
      <p className="text-muted-foreground mb-2">
        Upload et billede af en færdig strikket trøje + (valgfrit) et billede af en garnnøgle i den nye farve. Beskriv evt. farven i tekst.
      </p>
      <p className="mb-6 text-sm">
        👉 Se{" "}
        <a href="/shop" className="text-primary underline font-medium">
          kunde-demoen her
        </a>{" "}
        (sådan vil widgetten se ud på din Shopify produktside).
      </p>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div className="space-y-2">
          <Label>1. Trøje / vest / hue (original)</Label>
          <Input type="file" accept="image/*" onChange={(e) => handleFile(e, setGarment)} />
          {garment && <img src={garment} alt="garment" className="rounded-lg border max-h-64 object-contain" />}
        </div>
        <div className="space-y-2">
          <Label>2. Garnnøgle i den nye farve (valgfrit)</Label>
          <Input type="file" accept="image/*" onChange={(e) => handleFile(e, setYarn)} />
          {yarn && <img src={yarn} alt="yarn" className="rounded-lg border max-h-64 object-contain" />}
        </div>
      </div>

      <div className="space-y-2 mb-6">
        <Label>Farvebeskrivelse (valgfrit, fx "støvet lyserød", "dyb skovgrøn")</Label>
        <Textarea value={colorDesc} onChange={(e) => setColorDesc(e.target.value)} placeholder="fx kongeblå med lidt violet undertone" />
      </div>

      <Button onClick={run} disabled={!garment || loading} size="lg">
        {loading ? "Genererer..." : "Skift farve med AI"}
      </Button>

      {error && <p className="text-destructive mt-4">{error}</p>}

      {result && (
        <div className="mt-8 space-y-2">
          <Label>Resultat {isFinal ? "(færdig)" : "(genererer...)"}</Label>
          <img
            src={result}
            alt="result"
            className={`rounded-lg border w-full max-w-2xl transition-[filter] duration-300 ${
              isFinal ? "blur-0" : "blur-2xl"
            }`}
          />
        </div>
      )}
    </div>
  );
}
