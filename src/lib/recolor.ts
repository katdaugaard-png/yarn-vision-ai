import { createParser } from "eventsource-parser";
import { flushSync } from "react-dom";

export async function streamRecolor(
  body: { garmentImage: string; yarnImage?: string; colorDescription?: string },
  onFrame: (dataUrl: string, isFinal: boolean) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/recolor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Recolor failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  let sawCompleted = false;
  const parser = createParser({
    onEvent(event) {
      if (
        event.event !== "image_generation.partial_image" &&
        event.event !== "image_generation.completed"
      )
        return;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const isFinal = event.event === "image_generation.completed";
      flushSync(() => {
        onFrame(`data:image/png;base64,${payload.b64_json}`, isFinal);
      });
      if (isFinal) sawCompleted = true;
    },
  });

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!sawCompleted) throw new Error("Stream ended without completed event");
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
