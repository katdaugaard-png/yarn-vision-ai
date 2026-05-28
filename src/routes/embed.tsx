import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

// Standalone embed page: renders ONLY the floating bubble (added globally in __root.tsx).
// Uses postMessage to tell the parent (Shopify) iframe how big to be — small when
// the bubble is collapsed, full-screen when the dialog is open.
export const Route = createFileRoute("/embed")({
  component: EmbedPage,
});

function EmbedPage() {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";

    function notify(expanded: boolean) {
      window.parent?.postMessage(
        { type: "daugaard-kit-widget", expanded },
        "*",
      );
    }

    // Watch for the Radix dialog opening/closing.
    const observer = new MutationObserver(() => {
      const dialogOpen = !!document.querySelector('[role="dialog"][data-state="open"]');
      notify(dialogOpen);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    notify(false);

    // Bridge: parent → in-iframe widget
    function onMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || d.type !== "daugaard-kit-open") return;
      window.dispatchEvent(
        new CustomEvent("daugaard-kit-open", { detail: { handle: d.handle } }),
      );
    }
    window.addEventListener("message", onMessage);

    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
