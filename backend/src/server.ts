import { buildApp } from "./app.js";
import { closePools } from "./db/client.js";
import { startScheduler, stopScheduler } from "./jobs/scheduler.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const app = await buildApp();

// The scheduler starts with the server (queue + worker always; the cron
// schedule itself is gated by SYNC_SCHEDULE_ENABLED). A misconfiguration here
// should crash the boot loudly, before listen().
await startScheduler();

// Drain in-flight requests, let running jobs finish (bounded), and close pools
// before exiting, so a deploy does not sever a transaction mid-write.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    await app.close();
    await stopScheduler();
    await closePools();
    process.exit(0);
  });
}

try {
  await app.listen({ port, host });
  console.log(`backend listening on http://${host}:${port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
