// Shared between server and client: the post model, link extraction and the feed generators.

export interface Author {
  id: string;
  username: string;
  displayName: string;
}

export interface Preview {
  title: string | null;
  description: string | null;
  /** site-relative (/previews/<hash>.jpg) or absolute (og:image) */
  image: string | null;
  siteName: string | null;
}

/** A picture attached to a post, served by the app (members only, like previews). */
export interface PostImage {
  /** site-relative: /images/<post id> */
  src: string;
  type: string;
  width: number;
  height: number;
}

export interface Post {
  id: string;
  text: string;
  /** first URL in the text: gets a preview card */
  link: string | null;
  /** second URL, if any */
  ref: string | null;
  /** the picture, if one was attached */
  image: PostImage | null;
  /** labels: the #hashtags in the text plus any set separately, normalized (see normalizeTag) */
  tags: string[];
  /** only the author sees it: never in anyone else's timeline, profile view, feed or post page */
  private: boolean;
  createdAt: string;
  author: Author;
  preview: Preview | null;
  refPreview: Preview | null;
  likes: number;
  comments: number;
  likedByMe: boolean;
}

export interface Comment {
  id: string;
  postId: string;
  text: string;
  createdAt: string;
  author: Author;
}

export interface FeedOptions {
  siteUrl: string;
  title: string;
  description: string;
  /** the reader's feed token: feeds and preview images need an account, so it rides along in the URLs */
  token?: string;
}

export const APP_NAME = "Murmur";
/** What a post is called in the app: you murmur something. (The API keeps `posts`.) */
export const POST_NOUN = "murmur";
export const POST_MAX = 500;
export const COMMENT_MAX = 500;

export const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const stripTrailingPunct = (u: string) => u.replace(/[.,;:!?]+$/, "");

/** The links in a post's text: first is the main link (previewed), second the ref. */
export const extractLinks = (text: string): { link: string | null; ref: string | null } => {
  const urls = [...new Set((text.match(URL_RE) || []).map(stripTrailingPunct))];
  return { link: urls[0] || null, ref: urls[1] || null };
};

// ---------- tags ----------

export const TAG_MAX = 30;
export const TAGS_MAX = 10;
const TAG_CHARS = /^[\p{L}\p{N}_-]+$/u;
/** A #tag in text. Not preceded by a word character, `&`, `/` or `#`, so URL fragments and `&#x27;` don't count. */
export const HASHTAG_RE = /(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_-]+)/gu;

/** Lower-cased, without the leading #; null when it isn't a usable tag. */
export const normalizeTag = (raw: string): string | null => {
  const t = raw.trim().replace(/^#+/, "").toLowerCase();
  if (!t || t.length > TAG_MAX || !TAG_CHARS.test(t) || /^[_-]+$/.test(t)) return null;
  return t;
};

/** "a, b #c" -> ["a", "b", "c"]: a separately typed tag list, comma or whitespace separated. */
export const parseTagList = (raw: string): string[] => uniqueTags(raw.split(/[\s,]+/).map(normalizeTag));

/** The #hashtags in a post's text (URLs are skipped), in order of appearance. */
export const extractTags = (text: string): string[] =>
  uniqueTags([...text.replace(URL_RE, " ").matchAll(HASHTAG_RE)].map((m) => normalizeTag(m[1]!)));

/** Everything a post is labelled with: hashtags in the text first, then the separate list; at most TAGS_MAX. */
export const postTags = (text: string, extra: string[] = []): string[] => uniqueTags([...extractTags(text), ...extra.map(normalizeTag)]);

const uniqueTags = (tags: (string | null)[]): string[] => [...new Set(tags.filter((t): t is string => !!t))].slice(0, TAGS_MAX);

export const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export const permalink = (siteUrl: string, id: string) => `${siteUrl}/p/${id}`;

// ---------- feeds ----------

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
export const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

const absolute = ({ siteUrl, token }: FeedOptions, src: string) =>
  src.startsWith("/") ? `${siteUrl}${src}${token ? `?token=${encodeURIComponent(token)}` : ""}` : src;

const feedUrl = ({ siteUrl, token }: FeedOptions, file: string) => `${siteUrl}/${file}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

export const itemTitle = (p: Post) => {
  const first = p.text.split("\n")[0].trim();
  const t = first.length > 90 ? first.slice(0, 87).trimEnd() + "…" : first;
  return t || p.preview?.title || (p.link ? host(p.link) : p.image ? `A picture from @${p.author.username}` : `@${p.author.username}`);
};

const itemHtml = (p: Post, opts: FeedOptions) => {
  const { siteUrl } = opts;
  const parts: string[] = [];
  if (p.text) parts.push(`<p>${escapeHtml(p.text).replace(/\n/g, "<br>")}</p>`);
  if (p.image) parts.push(`<p><img src="${escapeHtml(absolute(opts, p.image.src))}" width="${p.image.width}" height="${p.image.height}" alt=""></p>`);
  if (p.link) {
    const t = p.preview?.title || host(p.link);
    parts.push(
      `<p><a href="${escapeHtml(p.link)}"><strong>${escapeHtml(t)}</strong></a>` +
        (p.preview?.description ? `<br>${escapeHtml(p.preview.description)}` : "") +
        `<br><small>${escapeHtml(host(p.link))}</small></p>`
    );
    if (p.preview?.image) {
      parts.push(`<p><a href="${escapeHtml(p.link)}"><img src="${escapeHtml(absolute(opts, p.preview.image))}" alt=""></a></p>`);
    }
  }
  parts.push(`<p><small>@${escapeHtml(p.author.username)} · <a href="${escapeHtml(permalink(siteUrl, p.id))}">${p.likes} likes, ${p.comments} comments</a></small></p>`);
  return parts.join("\n");
};

export const toRss = (posts: Post[], opts: FeedOptions) => {
  const { siteUrl, title, description } = opts;
  const items = posts
    .map(
      (p) => `    <item>
      <title>${escapeXml(itemTitle(p))}</title>
      <link>${escapeXml(permalink(siteUrl, p.id))}</link>
      <guid isPermaLink="true">${escapeXml(permalink(siteUrl, p.id))}</guid>
      <dc:creator>${escapeXml(p.author.displayName)}</dc:creator>
${p.tags.map((t) => `      <category>${escapeXml(t)}</category>\n`).join("")}      <pubDate>${new Date(p.createdAt).toUTCString()}</pubDate>
${p.image ? `      <enclosure url="${escapeXml(absolute(opts, p.image.src))}" type="${escapeXml(p.image.type)}" length="0" />\n` : ""}      <description><![CDATA[${itemHtml(p, opts)}]]></description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}/</link>
    <atom:link href="${escapeXml(feedUrl(opts, "feed.xml"))}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
};

export const toJsonFeed = (posts: Post[], opts: FeedOptions) =>
  JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: opts.title,
      description: opts.description,
      home_page_url: `${opts.siteUrl}/`,
      feed_url: feedUrl(opts, "feed.json"),
      items: posts.map((p) => ({
        id: permalink(opts.siteUrl, p.id),
        url: permalink(opts.siteUrl, p.id),
        ...(p.link ? { external_url: p.link } : {}),
        title: itemTitle(p),
        content_html: itemHtml(p, opts),
        content_text: p.text,
        authors: [{ name: p.author.displayName, url: `${opts.siteUrl}/u/${p.author.username}` }],
        ...(p.tags.length ? { tags: p.tags } : {}),
        ...(p.image ? { image: absolute(opts, p.image.src) } : p.preview?.image ? { image: absolute(opts, p.preview.image) } : {}),
        date_published: p.createdAt,
      })),
    },
    null,
    2
  );
