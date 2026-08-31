/**
 * Local web app for judging corpus frames by eye, one frame at a time.
 *
 * The automatic screen in `screen.ts` rejects burned-in overlays. Everything else that
 * makes a frame a bad benchmark item is a human call, and until now that call was made
 * against contact sheets in `tmp/review/`, which name a frame but cannot act on it. This
 * app closes that loop: one frame fills the window, and one arrow key records the verdict.
 *
 *   up     keep the frame, go to the next one
 *   down   drop the frame, go to the next one
 *   left   turn it 90 degrees counterclockwise, stay on it
 *   right  turn it 90 degrees clockwise, stay on it
 *
 * Every verdict lands in a committed text file, never in memory only, because a
 * judgement that lives in a session is lost. Drops go to `benchmark/samples/rejected.txt`
 * with the reason `drop`, which is the file `sample.ts` already obeys. Keeps go to
 * `benchmark/samples/reviewed.txt`. Rotations go to `benchmark/samples/rotated.txt` and
 * are applied to the committed copy under `benchmark/images/<role>/`.
 *
 * A frame named in any of those files is settled and is not shown again. Delete its line
 * to see it again; that is the whole undo mechanism, and it needs no code.
 *
 * Frames are ordered most suspicious first when `tmp/analysis/updown.json` is present.
 * The defect is not spread evenly, so this order finds most of it in the first sheets
 * and lets a session stop when the hits stop.
 *
 * Usage: npm run review               (then open the printed URL)
 *        npm run review -- --tailnet  (also publish it to the tailnet)
 */
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendReject, loadRejects, REJECTS_PATH } from "./rejects.ts";
import { appendReviewed, loadReviewed } from "./reviewed.ts";
import { FRAMES_ROOT, frameDir, framePath } from "./frames.ts";
import { indexImages } from "./osv5m.ts";
import {
  loadRotations,
  renderRotated,
  ROTATIONS_PATH,
  saveRotations,
  type Angle,
  type Turn,
} from "./rotations.ts";

const ORDER_PATH = join("tmp", "analysis", "updown.json");
const UI_PATH = join(import.meta.dirname, "review.html");
const PORT = Number(process.env.REVIEW_PORT ?? 5173);

/**
 * Whether to publish the app to the tailnet. Off by default: it changes the state of the
 * machine outside this repository, which no flagless command should do.
 */
const TAILNET = process.argv.includes("--tailnet");

/**
 * Tailnet port the proxy listens on. 80 needs no certificate. Override it when port 80
 * of this machine's tailnet name already serves something else.
 */
const TAILNET_PORT = process.env.REVIEW_TAILNET_PORT ?? "80";

/** The reason written for every frame dropped from the app. */
const DROP_REASON = "drop";

const ROLES: Record<string, true> = { eval: true, train: true };

/** Which corpus a frame belongs to, which is also its folder under benchmark/images. */
type Role = string;

type Item = { id: string; role: Role };

/** Anti-traversal: an OSV-5M id is a bare number, and nothing else is served. */
const ID = /^[0-9A-Za-z_-]+$/;

const NEXT_CW: Record<Turn, Turn> = { 0: 90, 90: 180, 180: 270, 270: 0 };
const NEXT_CCW: Record<Turn, Turn> = { 0: 270, 90: 0, 180: 90, 270: 180 };

/**
 * Suspicion score per frame, most suspicious first, when the analysis file is present.
 * Its absence is normal: `tmp/` is not committed. Then ids are shown in id order, which
 * is arbitrary but stable, so a session resumed tomorrow continues where it stopped.
 */
async function loadOrder(path = ORDER_PATH): Promise<Map<string, number>> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (text === "") return new Map();
  const rows: { id: string; score: number }[] = JSON.parse(text);
  return new Map(rows.map((row) => [row.id, row.score]));
}

const [rejects, kept, order] = await Promise.all([loadRejects(), loadReviewed(), loadOrder()]);
const rotations = await loadRotations();

const frames: Item[] = [];
for (const role of Object.keys(ROLES)) {
  const names = await readdir(frameDir(role)).catch(() => []);
  for (const name of names) {
    if (name.endsWith(".jpg")) frames.push({ id: name.slice(0, -4), role });
  }
}
if (frames.length === 0) {
  console.error(`no frames under ${FRAMES_ROOT}. Build them with \`npm run collect\`.`);
  process.exit(1);
}

// Ranked frames first, most suspicious first; unranked frames after them, by id.
frames.sort((a, b) => {
  const sa = order.get(a.id);
  const sb = order.get(b.id);
  if (sa !== undefined && sb !== undefined) return sb - sa;
  if (sa !== undefined) return -1;
  if (sb !== undefined) return 1;
  return a.id < b.id ? -1 : 1;
});

const queue = frames.filter((item) => !kept.has(item.id) && !rejects.has(item.id));
const drops: Item[] = [];

/**
 * Bumped by every rotation. The image URL carries it, so a rotated frame gets a URL the
 * browser has never seen while unrotated frames stay cacheable and prefetchable.
 */
let tick = 0;

let sources: Promise<Map<string, string>> | undefined;

/**
 * Path of the frame as the dataset shipped it. Rotation reads this, never the copy it is
 * about to overwrite, so repeated presses cost one re-encode and 0 degrees restores the
 * original bytes.
 */
async function sourceOf(id: string): Promise<string> {
  sources ??= indexImages("test");
  const path = (await sources).get(id);
  if (path === undefined) {
    throw new Error(
      `frame ${id} is not in the local dataset, so it cannot be rotated. Unpack the ` +
        `OSV-5M test shards listed in docs/benchmark/reproduce.md.`,
    );
  }
  return path;
}

function describe(item: Item | undefined): (Item & { angle: Turn }) | null {
  if (item === undefined) return null;
  return { ...item, angle: rotations.get(item.id) ?? 0 };
}

function state(): unknown {
  return {
    total: frames.length,
    settled: frames.length - queue.length,
    tick,
    item: describe(queue[0]),
    // Two frames ahead, so the browser can fetch them while a decision is being made.
    next: [describe(queue[1]), describe(queue[2])].filter((entry) => entry !== null),
    drops,
  };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

/**
 * Verdicts and rotations act on the head of the queue only, and the client has to name
 * it. A stale tab would otherwise drop the frame that replaced the one it was showing.
 */
function head(id: string | undefined): Item {
  const item = queue[0];
  if (item === undefined) throw new Error("the queue is empty");
  if (id !== item.id) throw new Error(`the queue is at ${item.id}, not ${id}`);
  return item;
}

async function verdict(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const item = head(body.id);

  if (body.verdict === "drop") {
    await appendReject(item.id, DROP_REASON);
    rejects.set(item.id, DROP_REASON);
    drops.push(item);
    // A reviewer often turns a frame upright, looks again and drops it anyway. The
    // rotation is then a verdict about a frame no corpus holds, so it goes with it.
    if (rotations.delete(item.id)) await saveRotations(rotations);
  } else if (body.verdict === "keep") {
    await appendReviewed(item.id);
    kept.add(item.id);
  } else {
    throw new Error(`unknown verdict \`${body.verdict}\`. Use keep or drop.`);
  }

  // Printed as it happens, not only when the process ends: a terminal that scrolled is
  // still a record, and Ctrl+C is not guaranteed to run a handler on every platform.
  console.log(`${body.verdict === "drop" ? "drop" : "keep"}     ${item.id} ${item.role}`);
  queue.shift();
  json(res, 200, state());
}

async function rotate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const item = head(body.id);
  if (body.dir !== "cw" && body.dir !== "ccw") {
    throw new Error(`unknown direction \`${body.dir}\`. Use cw or ccw.`);
  }

  const current = rotations.get(item.id) ?? 0;
  const angle = body.dir === "cw" ? NEXT_CW[current] : NEXT_CCW[current];
  const source = await sourceOf(item.id);
  const target = framePath(item.role, item.id);

  if (angle === 0) {
    rotations.delete(item.id);
    await writeFile(target, await readFile(source));
  } else {
    rotations.set(item.id, angle satisfies Angle);
    await writeFile(target, await renderRotated(source, angle));
  }
  await saveRotations(rotations);
  console.log(`turn     ${item.id} ${item.role} ${angle === 0 ? "as shipped" : `${angle}\u00b0`}`);
  tick++;

  json(res, 200, state());
}

async function image(url: URL, res: ServerResponse): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  const role = url.searchParams.get("role") ?? "";
  if (ROLES[role] !== true || !ID.test(id)) throw new Error(`no such frame: ${role}/${id}`);

  const bytes = await readFile(framePath(role, id));
  res.writeHead(200, {
    "content-type": "image/jpeg",
    "content-length": bytes.length,
    // The URL changes whenever the file does, so a long cache is safe and makes the
    // prefetch of the next frames worth doing.
    "cache-control": "public, max-age=3600",
  });
  res.end(bytes);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  const done = (async () => {
    if (route === "GET /") {
      const html = await readFile(UI_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (route === "GET /api/state") return json(res, 200, state());
    if (route === "GET /api/image") return await image(url, res);
    if (route === "POST /api/verdict") return await verdict(req, res);
    if (route === "POST /api/rotate") return await rotate(req, res);
    json(res, 404, { error: `no route ${route}` });
  })();

  // One reviewer, one tab: a failed action is reported in the page and the state is
  // re-read there, rather than being retried behind the reviewer's back.
  done.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${route}: ${message}`);
    if (!res.headersSent) json(res, 409, { error: message, state: state() });
    else res.end();
  });
});

/** The point of the session: what to drop. Printed as well as shown, so it survives. */
function report(): void {
  console.log(`\ndropped ${drops.length} frames this session`);
  for (const item of drops) console.log(`  ${item.id.padEnd(18)}${item.role}`);
  if (drops.length > 0) {
    console.log(`\nwritten to ${REJECTS_PATH}. Rebuild the corpora without them:`);
    console.log(`  node src/sample.ts --freeze`);
    console.log(`  npm run collect`);
  }
}

/**
 * Publishes the app on the tailnet through `tailscale serve`.
 *
 * Why a proxy and not the port itself: an inbound connection straight to Node is dropped
 * by the Windows firewall, whose node.exe rules cover the Public profile while the
 * Tailscale interface is Private. `tailscaled` already holds an allow rule for every
 * profile, so proxying through it needs neither a firewall rule nor an administrator.
 *
 * Plain HTTP on tailnet port 80, not HTTPS on 443: a certificate needs HTTPS enabled for
 * the whole tailnet, and WireGuard encrypts the hop either way.
 *
 * The target port comes from this process, so the proxy cannot point at a port nothing
 * listens on. That mistake is invisible from the phone, which shows only a connection
 * error, and it is the reason this is a flag and not a hand-typed command.
 */
async function publish(): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)("tailscale", [
      "serve",
      "--bg",
      `--http=${TAILNET_PORT}`,
      `http://127.0.0.1:${PORT}`,
    ]);
    for (const line of stdout.trim().split(/\r?\n/)) console.log(`tailnet  ${line}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tailnet  not published: ${message.trim()}`);
    console.error(`tailnet  the app still serves http://localhost:${PORT}`);
  }
}

/** Best effort: a proxy left pointing at a stopped app answers every request with 502. */
function unpublish(): void {
  if (!TAILNET) return;
  try {
    execFileSync("tailscale", ["serve", `--http=${TAILNET_PORT}`, "off"], { stdio: "ignore" });
    console.log(`tailnet  proxy on port ${TAILNET_PORT} removed`);
  } catch {
    console.error(`tailnet  remove the proxy with: tailscale serve --http=${TAILNET_PORT} off`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    report();
    unpublish();
    server.close();
    process.exit(0);
  });
}

// A second copy of the app, or a dev server on the same port, is the likeliest failure
// on start. It deserves a sentence, not a stack trace.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`port ${PORT} is busy. Close the other app, or set REVIEW_PORT.`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`frames   ${frames.length} in ${FRAMES_ROOT}`);
  console.log(`settled  ${frames.length - queue.length} already judged, ${queue.length} to go`);
  console.log(`order    ${order.size > 0 ? `most suspicious first, by ${ORDER_PATH}` : "by id"}`);
  console.log(`rotated  ${rotations.size} frames turned upright, per ${ROTATIONS_PATH}`);
  console.log(`review   http://localhost:${PORT}`);
  if (TAILNET) void publish();
  else console.log(`tailnet  add --tailnet to reach this from another device`);
});
