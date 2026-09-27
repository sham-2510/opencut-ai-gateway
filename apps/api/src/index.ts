import { Elysia, t } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

import { ai } from "./routes/ai";

export default new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({ status: "ok" }))
  .get("/health", () => ({ healthy: true, timestamp: new Date().toISOString() }))
  .post(
    "/echo",
    ({ body }) => body,
    {
      body: t.Object({ message: t.String() }),
    }
  )
  // xKiro-backed text, speech and image routes under /ai.
  .use(ai)
  // .compile() is required, it triggers AoT compilation at startup
  .compile();
