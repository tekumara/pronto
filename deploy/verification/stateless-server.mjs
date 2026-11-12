import { createServer } from "node:http";

const pod = process.env.POD_NAME;
const podUid = process.env.POD_UID;
if (!pod || !podUid) throw new Error("POD_NAME and POD_UID are required");

let ready = true;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://stateless-baseline");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    res.writeHead(ready ? 200 : 503).end(ready ? "ready" : "terminating");
    return;
  }
  if (req.method !== "GET" || url.pathname !== "/probe") {
    res.writeHead(404).end("not found");
    return;
  }

  const requestId = req.headers["x-probe-id"] ?? null;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Serving-Pod": pod,
    "X-Serving-Pod-Uid": podUid,
  }).end(JSON.stringify({ requestId, pod, podUid, servedAt: new Date().toISOString() }));
});

server.listen(8080, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listening", pod, podUid, port: 8080 }));
});

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  ready = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4_000).unref();
});
