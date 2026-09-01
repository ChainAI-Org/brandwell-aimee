import { AIMEE_SCREEN_STATE_MESSAGE } from "./lib/screen-connection.js";

export function renderAimeeScreenClient(nonce: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIMEE computer</title>
    <style>
      html,
      body,
      #screen-frame {
        width: 100%;
        height: 100%;
        margin: 0;
        border: 0;
        overflow: hidden;
        background: #090611;
      }

      #screen-status {
        position: fixed;
        inset: 0;
        z-index: 2;
        display: grid;
        place-items: center;
        padding: 24px;
        color: #d8cdf7;
        background: #090611;
        font: 500 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
        text-align: center;
      }

      #screen-status[hidden] {
        display: none;
      }
    </style>
    <script type="module" nonce="${nonce}">
      const frame = document.getElementById("screen-frame");
      const status = document.getElementById("screen-status");
      const providerView = new URL("./vnc.html", window.location.href);
      providerView.search = window.location.search;

      function reportState(state) {
        window.parent.postMessage({ type: "${AIMEE_SCREEN_STATE_MESSAGE}", state }, "*");
      }

      function setStatus(message, state) {
        status.textContent = message;
        status.hidden = !message;
        reportState(state);
      }

      function applyAimeeSkin() {
        const doc = frame.contentDocument;
        if (!doc?.documentElement) return;
        doc.title = "AIMEE computer";

        const skin = doc.createElement("style");
        skin.id = "aimee-screen-skin";
        skin.textContent = \`
          html, body {
            width: 100% !important;
            height: 100% !important;
            margin: 0 !important;
            overflow: hidden !important;
            background: #090611 !important;
          }
          #noVNC_control_bar_anchor,
          #noVNC_hint_anchor,
          #noVNC_status,
          #noVNC_connect_dlg,
          #noVNC_fallback_error,
          #noVNC_transition {
            display: none !important;
          }
          #noVNC_container {
            width: 100vw !important;
            height: 100vh !important;
            margin: 0 !important;
            overflow: hidden !important;
            background: #090611 !important;
          }
        \`;
        doc.head.append(skin);

        const providerStatus = doc.getElementById("noVNC_status");
        const syncStatus = () => {
          const value = providerStatus?.textContent?.trim().toLowerCase() || "";
          const connected = value.includes("connected") && !value.includes("disconnected");
          if (connected) setStatus("", "connected");
          else if (value.includes("fail") || value.includes("error") || value.includes("closed")) {
            setStatus(
              "The computer connection was lost. AIMEE is trying to reconnect.",
              "disconnected",
            );
          } else {
            setStatus("Connecting to the AIMEE computer...", "connecting");
          }
        };
        if (providerStatus) {
          new MutationObserver(syncStatus).observe(providerStatus, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
        syncStatus();
      }

      reportState("connecting");
      frame.addEventListener("load", applyAimeeSkin);
      frame.src = providerView.toString();
    </script>
  </head>
  <body>
    <div id="screen-status" role="status">Connecting to the AIMEE computer...</div>
    <iframe id="screen-frame" title="AIMEE computer"></iframe>
  </body>
</html>`;
}
