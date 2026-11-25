import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A raw HTTP client for tests, so a test can send any Host, Origin or Content-Type header
// (fetch fills Host in itself). Loopback only; never the real network.
export type Sent = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

export function send(
  server: Server,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Sent> {
  const port = portOf(server);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
