import path from "node:path";
import express from "express";
import { app, apiErrors } from "./app.js";
import { setup } from "./setup.js";
import { pool } from "./db.js";
await setup();
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found" }),
);
app.use(apiErrors);
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve("dist/client")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/client/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.resolve("vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(
    "Slotbook ready at " + (process.env.APP_URL ?? "http://localhost:3000"),
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
