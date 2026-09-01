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
      #screen {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #090611;
      }
    </style>
    <script type="module" nonce="${nonce}">
      import RFB from "./core/rfb.js";

      const params = new URLSearchParams(window.location.search);
      const prefix = window.location.pathname.replace(/[^/]+$/, "");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socketPath = String(params.get("path") || "websockify").replace(/^\\//, "");
      const credentials = { password: params.get("password") || "" };
      const rfb = new RFB(
        document.getElementById("screen"),
        \`\${protocol}://\${window.location.host}\${prefix}\${socketPath}\`,
        { credentials },
      );
      rfb.viewOnly = params.get("view_only") !== "false";
      rfb.scaleViewport = true;
      rfb.clipViewport = false;
      rfb.background = "#090611";
    </script>
  </head>
  <body>
    <div id="screen" aria-label="AIMEE computer"></div>
  </body>
</html>`;
}
