import { AIMEE_SCREEN_STATE_MESSAGE } from "./lib/screen-connection.js";

export function renderAimeeScreenClient(nonce: string, interactive = false) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIMEE computer</title>
    <style>
      html, body, #screen-viewport {
        width: 100%; height: 100%; margin: 0; border: 0;
        overflow: hidden; background: #090611;
      }
      #screen-status {
        position: fixed; inset: 0; z-index: 2; display: grid;
        place-items: center; padding: 24px; color: #d8cdf7;
        background: #090611;
        font: 500 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
        text-align: center;
      }
      #screen-status[hidden] { display: none; }
    </style>
    <script type="module" nonce="${nonce}">
      const viewport = document.getElementById("screen-viewport");
      const status = document.getElementById("screen-status");
      const params = new URLSearchParams(window.location.search);
      const moduleUrl = new URL("./core/rfb.js", window.location.href);
      const socketUrl = new URL("./websockify", window.location.href);
      socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      let client;
      let retry;
      let disposed = false;

      function reportState(state) {
        window.parent.postMessage({ type: "${AIMEE_SCREEN_STATE_MESSAGE}", state }, "*");
      }
      function setStatus(message, state) {
        status.textContent = message;
        status.hidden = !message;
        reportState(state);
      }
      function connect(RFB) {
        if (disposed) return;
        clearTimeout(retry);
        viewport.replaceChildren();
        setStatus("Connecting to the AIMEE computer...", "connecting");
        let accessExpired = false;
        try {
          client = new RFB(viewport, socketUrl.toString(), {
            credentials: { password: params.get("password") || undefined },
            shared: true,
          });
          client.viewOnly = ${interactive ? "false" : "true"};
          client.scaleViewport = true;
          client.resizeSession = false;
          client.background = "#090611";
          client.addEventListener("connect", () => setStatus("", "connected"));
          client.addEventListener("disconnect", () => {
            if (disposed || accessExpired) return;
            setStatus("The computer connection was lost. AIMEE is trying to reconnect.", "disconnected");
            retry = setTimeout(() => connect(RFB), 3000);
          });
          client.addEventListener("credentialsrequired", () => {
            accessExpired = true;
            setStatus("Reopen the computer to refresh its access.", "disconnected");
          });
          client.addEventListener("securityfailure", () => {
            accessExpired = true;
            setStatus("Reopen the computer to refresh its access.", "disconnected");
          });
        } catch {
          setStatus("The computer could not connect. Close and reopen it to try again.", "disconnected");
        }
      }
      reportState("connecting");
      import(moduleUrl.toString()).then(({ default: RFB }) => connect(RFB)).catch(() => {
        setStatus("The computer could not load. Close and reopen it to try again.", "disconnected");
      });
      window.addEventListener("pagehide", () => {
        disposed = true;
        clearTimeout(retry);
        client?.disconnect();
      });
    </script>
  </head>
  <body>
    <div id="screen-status" role="status">Connecting to the AIMEE computer...</div>
    <div id="screen-viewport" aria-label="AIMEE computer screen"></div>
  </body>
</html>`;
}
