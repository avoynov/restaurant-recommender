// Turn user input into canonical targets: profile handles or post shortcodes.
//
// Accepted:  nasa, @nasa, instagram.com/nasa, https://www.instagram.com/nasa/?hl=en
//            /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, instagr.am/p/{code}, /{user}/p/{code}
// Rejected:  Stories, highlights, explore pages, non-Instagram links (with a clear message).

const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,}$/;
const POST_KINDS = new Set(["p", "reel", "reels", "tv"]);
const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"]);
const RESERVED = new Set(["explore", "stories", "accounts", "direct", "about", "developer", "legal", "web",
  "emails", "challenge", "graphql", "api", "s", "highlights", "locations"]);

export class InputError extends Error {}

export const profileUrl = (handle) => `https://www.instagram.com/${handle}/`;
// /reel/ and /p/ share one shortcode, so /p/ is the canonical form.
export const postUrl = (code) => `https://www.instagram.com/p/${code}/`;

export function targetUrl(t) {
  return t.kind === "profile" ? profileUrl(t.value) : postUrl(t.value);
}

export function parseTarget(raw) {
  let s = String(raw ?? "").trim();
  if (!s) throw new InputError("empty input");
  if (s.startsWith("@")) return handle(s.slice(1));
  if (!s.includes("/") && !/\.(com|am|net|org|io|co)$/i.test(s)) return handle(s);

  let url;
  try {
    url = new URL(s.includes("://") ? s : "https://" + s);
  } catch {
    throw new InputError(`not an Instagram link or handle: ${JSON.stringify(raw)}`);
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) throw new InputError(`not an Instagram link or handle: ${JSON.stringify(raw)}`);
  const segs = url.pathname.split("/").filter(Boolean);
  if (!segs.length) throw new InputError(`link has no profile or post: ${JSON.stringify(raw)}`);

  const head = segs[0].toLowerCase();
  if (POST_KINDS.has(head)) {
    if (segs.length < 2 || !SHORTCODE_RE.test(segs[1])) throw new InputError(`post link has no valid shortcode: ${JSON.stringify(raw)}`);
    return { kind: "post", value: segs[1] };
  }
  if (segs.length >= 3 && POST_KINDS.has(segs[1].toLowerCase()) && SHORTCODE_RE.test(segs[2])) {
    return { kind: "post", value: segs[2] };
  }
  if (RESERVED.has(head)) throw new InputError(`Stories, highlights and other non-post pages are not supported: ${JSON.stringify(raw)}`);
  if (segs.length === 1 || (segs.length === 2 && ["reels", "tagged", "feed"].includes(segs[1].toLowerCase()))) return handle(segs[0]);
  throw new InputError(`unrecognised Instagram link: ${JSON.stringify(raw)}`);
}

function handle(s) {
  if (!HANDLE_RE.test(s) || s.startsWith(".") || s.endsWith(".") || s.includes("..")) {
    throw new InputError(`invalid Instagram handle: ${JSON.stringify(s)}`);
  }
  if (RESERVED.has(s.toLowerCase())) throw new InputError(`${JSON.stringify(s)} is an Instagram page, not a profile`);
  return { kind: "profile", value: s.toLowerCase() };
}

/** Shortcode from a post URL, or null. */
export function shortcodeOf(url) {
  if (!url) return null;
  try {
    const t = parseTarget(url);
    return t.kind === "post" ? t.value : null;
  } catch {
    return null;
  }
}
