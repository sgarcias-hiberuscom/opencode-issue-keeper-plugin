// Test registry: serves a fixed packument and tarball over 127.0.0.1 on an
// ephemeral port. Options force failure modes: 404 packument, missing integrity
// (the installer's own verification must reject), a different package name,
// and a tarball response cut short.
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function startRegistryServer(tarballPath, options = {}) {
  const tarball = await readFile(resolve(tarballPath));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  let port;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (decodeURIComponent(url.pathname) === "/@issuekeeper/opencode-jira") {
      if (options.missing) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Not Found", reason: "version not found" }));
        return;
      }
      const name = options.otherName ? "@issuekeeper/opencode-other" : pkg.name;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name,
        "dist-tags": { latest: pkg.version },
        versions: { [pkg.version]: { name, version: pkg.version, dist: { tarball: `http://127.0.0.1:${port}/tarball.tgz`, ...(options.wrongIntegrity ? {} : { integrity }) } } },
      }));
      return;
    }
    if (url.pathname === "/tarball.tgz" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/x-tar" });
      response.end(options.truncate ? tarball.subarray(0, Math.floor(tarball.length / 2)) : tarball);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
  });
  await new Promise((listen) => server.listen(0, "127.0.0.1", listen));
  port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((close) => server.close(() => close())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startRegistryServer(process.argv[2] ?? "");
  console.log(server.url);
}
