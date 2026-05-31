import { createFileRoute } from "@tanstack/react-router";

// Loader script that Shopify includes via <script src="...">.
// Injects a transparent iframe that is small when the bubble is collapsed and
// full-screen when the dialog is open. Size is driven by postMessage from /embed.
export const Route = createFileRoute("/widget.js")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const embedSrc = `${origin}/embed`;

        const js = `(function(){
  if (window.__daugaardKitWidgetLoaded) return;
  window.__daugaardKitWidgetLoaded = true;

  var EXPECTED_ORIGIN = ${JSON.stringify(origin)};

  // Inner bubble sits at bottom:20px right:20px inside the iframe.
  // We offset the iframe so the bubble's visible position on the host page is:
  //   desktop: bottom 105px, right 24px
  //   mobile:  bottom 95px,  right 18px
  var INNER_PAD = 20;
  var DESKTOP_BOTTOM = 105 - INNER_PAD; // 85
  var DESKTOP_RIGHT  = Math.max(0, 24 - INNER_PAD); // 4
  var MOBILE_BOTTOM  = 95 - INNER_PAD;  // 75
  var MOBILE_RIGHT   = Math.max(0, 18 - INNER_PAD); // 0

  var iframe = document.createElement('iframe');
  iframe.src = ${JSON.stringify(embedSrc)};
  iframe.title = 'Kit farvevælger';
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = [
    'position:fixed',
    'border:0','background:transparent',
    // Below typical chatbot bubbles (which usually sit at 2147483647)
    'z-index:2147482000',
    'transition:width .2s ease, height .2s ease, inset .2s ease',
    'color-scheme:normal'
  ].join(';');

  function isMobile(){
    return window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  }

  function applyCollapsed(){
    var mobile = isMobile();
    iframe.style.width = '260px';
    iframe.style.height = '90px';
    iframe.style.inset = 'auto ' + (mobile ? MOBILE_RIGHT : DESKTOP_RIGHT) + 'px '
                       + (mobile ? MOBILE_BOTTOM : DESKTOP_BOTTOM) + 'px auto';
  }

  function setExpanded(expanded){
    if (expanded) {
      iframe.style.inset = '0';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
    } else {
      applyCollapsed();
    }
  }

  window.addEventListener('resize', function(){
    // Only re-apply if currently collapsed
    if (iframe.style.width === '260px') applyCollapsed();
  });

  window.addEventListener('message', function(e){
    if (e.origin !== EXPECTED_ORIGIN) return;
    var d = e.data;
    if (!d || d.type !== 'daugaard-kit-widget') return;
    setExpanded(!!d.expanded);
  });

  function getProductHandle(){
    var m = window.location.pathname.match(/\\/products\\/([^\\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function postOpen(handle){
    setExpanded(true);
    try {
      iframe.contentWindow && iframe.contentWindow.postMessage(
        { type: 'daugaard-kit-open', handle: handle || null },
        EXPECTED_ORIGIN
      );
    } catch(_){}
  }

  // Cache of known kit handles fetched from the catalog API.
  // null = not yet fetched, Set = fetched (only handles in catalog are included).
  var _knownHandles = null;

  function fetchKnownHandles(cb){
    if (_knownHandles !== null){ cb(_knownHandles); return; }
    fetch(EXPECTED_ORIGIN + '/api/shopify-kits')
      .then(function(r){ return r.json(); })
      .then(function(d){
        var s = new Set();
        if (d && Array.isArray(d.kits)){
          d.kits.forEach(function(k){ if (k.handle) s.add(k.handle); });
        }
        _knownHandles = s;
        cb(s);
      })
      .catch(function(){
        // On network error, fall back to showing the button (fail closed).
        _knownHandles = null;
        cb(null);
      });
  }

  function renderProductButton(){
    var slot = document.getElementById('yarn-visualizer-button');
    if (!slot || slot.getAttribute('data-daugaard-mounted') === '1') return;
    slot.setAttribute('data-daugaard-mounted','1');

    var handle = getProductHandle();

    // Check catalog: only show button if this product handle is a known kit.
    fetchKnownHandles(function(handles){
      // If fetch failed (handles === null) we show the button anyway.
      if (handles !== null && handle && !handles.has(handle)) {
        try { console.log('Yarn visualizer: product not in catalog, hiding button', handle); } catch(_){}
        return;
      }

      // Outer wrapper provides top margin so it doesn't crowd "Læg i indkøbskurv"
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:16px;width:100%;';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Se kittet i andre farver';
      btn.setAttribute('aria-label','Se kittet i andre farver');
      btn.style.cssText = [
        'display:inline-flex','align-items:center','justify-content:center','gap:8px',
        'width:100%',
        'padding:12px 20px',
        'background:transparent','color:#5a3a22',
        'border:1px solid #c9b39a','border-radius:9999px',
        'font-family:inherit','font-size:14px','font-weight:500','letter-spacing:.01em',
        'cursor:pointer',
        'box-shadow:none',
        'transition:background .15s ease, border-color .15s ease, color .15s ease'
      ].join(';');
      btn.onmouseenter = function(){ btn.style.background = '#f5ede2'; btn.style.borderColor = '#b59976'; };
      btn.onmouseleave = function(){ btn.style.background = 'transparent'; btn.style.borderColor = '#c9b39a'; };
      btn.addEventListener('click', function(){ postOpen(handle); });

      var icon = document.createElement('span');
      icon.textContent = '\u2728';
      icon.style.cssText = 'font-size:13px;line-height:1;opacity:.8';
      btn.insertBefore(icon, btn.firstChild);

      wrap.appendChild(btn);
      slot.appendChild(wrap);

      try { console.log('Yarn visualizer button mounted', handle); } catch(_){}
    });
  }


  function watchForSlot(){
    renderProductButton();
    var mo = new MutationObserver(function(){ renderProductButton(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }


  function mount(){
    if (document.body) {
      applyCollapsed();
      document.body.appendChild(iframe);
      watchForSlot();
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  }
  mount();
})();`;

        return new Response(js, {
          status: 200,
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
