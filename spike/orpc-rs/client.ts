// Drives the Rust spike with the exact @orpc/client the app uses (symlinked node_modules).
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { Procedures } from "./bindings";

const ORIGIN = process.env.SPIKE_ORIGIN || "http://127.0.0.1:8081";
let cookie = "";
const link = new RPCLink({
  url: `${ORIGIN}/rpc`,
  headers: () => (cookie ? { cookie } : {}),
  fetch: async (req, init) => {
    const res = await fetch(req, init);
    const sc = res.headers.get("set-cookie");
    if (sc) {
      console.log("  set-cookie:", sc);
      cookie = sc.split(";")[0];
      if (cookie.endsWith("=")) cookie = "";
    }
    return res;
  },
});
const api: Procedures = createORPCClient(link);

let failed = 0;
const check = (cond: unknown, msg: string, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`, extra === undefined ? "" : JSON.stringify(extra));
  if (!cond) failed++;
};

// 1. no-input procedure, typed output
const h = await api.health();
check(h.status === "ok" && typeof h.uptime === "number", "health() returns typed output", h);

// 2. ORPCError with status + data (what /api/health does when Turso is down)
try {
  await api.boom();
  check(false, "boom() should throw");
} catch (e) {
  const err = e as ORPCError<string, { status: string }>;
  check(e instanceof ORPCError, "error is an ORPCError instance");
  check(err.status === 503 && err.code === "SERVICE_UNAVAILABLE", "status 503 / code", { status: err.status, code: err.code });
  check(err.message.includes("connection refused"), "message preserved", err.message);
  check(err.data?.status === "degraded", "data payload preserved", err.data);
}

// 3. optional input: called with nothing, and with an object
const o1 = await api.auth.loginOptions();
check(o1.challengeId === "ch1" && o1.options.allowCredentials === null, "loginOptions() with no input", o1);
const o2 = await api.auth.loginOptions({ username: "johan" });
check(Array.isArray(o2.options.allowCredentials), "loginOptions({username}) with input", o2.options);

// 4. unauthenticated → UNAUTHORIZED from middleware
const s0 = await api.auth.status();
check(s0.user === null, "status() signed out → user null", s0);
try {
  await api.posts.list();
  check(false, "posts.list() should need auth");
} catch (e) {
  check(e instanceof ORPCError && e.status === 401, "posts.list() signed out → 401", (e as ORPCError<string, unknown>).code);
}

// 5. login sets a cookie through the procedure; later calls carry it
const l = await api.auth.login();
check(l.user.username === "johan", "login() returns user", l);
check(cookie === "session=s3cret", "login() set the session cookie", cookie);
const s1 = await api.auth.status();
check(s1.user?.username === "johan", "status() signed in → user", s1);

// 6. authed procedure with optional input (none)
const posts = await api.posts.list();
check(posts.length === 3 && posts[0].author.username === "johan", "posts.list() signed in", posts.length);
const few = await api.posts.list({ limit: 1, tag: "rust" });
check(few.length === 1 && few[0].tags[0] === "rust", "posts.list({limit, tag})", few);

// 7. multipart upload: a File inside the input, like the composer does
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const file = new File([bytes], "photo.jpg", { type: "image/jpeg" });
const created = await api.posts.create({ text: "hello #rust", tags: ["rust"], private: true, image: file, imageWidth: 640 });
check(created.image?.bytes === 12 && created.image?.type === "image/jpeg", "posts.create with File → bytes + type arrive", created.image);
check(created.image?.name === "photo.jpg" && created.image?.width === 640 && created.image?.sha_prefix === "ffd8", "file name, sibling fields and content intact", created.image);
check(created.private === true && created.text === "hello #rust", "other fields intact alongside the file", { private: created.private, text: created.text });

// 8. plain JSON create (no file) still works, and validation errors come back as 400
const plain = await api.posts.create({ text: "no picture" });
check(plain.image === null && plain.text === "no picture", "posts.create without a file", plain);
try {
  await api.posts.create({ text: "" });
  check(false, "empty post should fail");
} catch (e) {
  check(e instanceof ORPCError && e.status === 400 && e.message.includes("say something"), "empty post → BAD_REQUEST with message", (e as Error).message);
}

// 9. logout clears the cookie
await api.auth.logout();
check(cookie === "", "logout() cleared the cookie");
const s2 = await api.auth.status();
check(s2.user === null, "status() after logout → null", s2);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
