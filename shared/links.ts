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

export interface Post {
  id: string;
  text: string;
  /** first URL in the text: gets a preview card */
  link: string | null;
  /** second URL, if any */
  ref: string | null;
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
}

export const APP_NAME = "Murmur";
export const POST_MAX = 500;
export const COMMENT_MAX = 500;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const stripTrailingPunct = (u: string) => u.replace(/[.,;:!?]+$/, "");

/** The links in a post's text: first is the main link (previewed), second the ref. */
export const extractLinks = (text: string): { link: string | null; ref: string | null } => {
  const urls = [...new Set((text.match(URL_RE) || []).map(stripTrailingPunct))];
  return { link: urls[0] || null, ref: urls[1] || null };
};

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

const absolute = (siteUrl: string, src: string) => (src.startsWith("/") ? siteUrl + src : src);

export const itemTitle = (p: Post) => {
  const first = p.text.split("\n")[0].trim();
  const t = first.length > 90 ? first.slice(0, 87).trimEnd() + "…" : first;
  return t || p.preview?.title || (p.link ? host(p.link) : `@${p.author.username}`);
};

const itemHtml = (p: Post, siteUrl: string) => {
  const parts: string[] = [];
  parts.push(`<p>${escapeHtml(p.text).replace(/\n/g, "<br>")}</p>`);
  if (p.link) {
    const t = p.preview?.title || host(p.link);
    parts.push(
      `<p><a href="${escapeHtml(p.link)}"><strong>${escapeHtml(t)}</strong></a>` +
        (p.preview?.description ? `<br>${escapeHtml(p.preview.description)}` : "") +
        `<br><small>${escapeHtml(host(p.link))}</small></p>`
    );
    if (p.preview?.image) {
      parts.push(`<p><a href="${escapeHtml(p.link)}"><img src="${escapeHtml(absolute(siteUrl, p.preview.image))}" alt=""></a></p>`);
    }
  }
  parts.push(`<p><small>@${escapeHtml(p.author.username)} · <a href="${escapeHtml(permalink(siteUrl, p.id))}">${p.likes} likes, ${p.comments} comments</a></small></p>`);
  return parts.join("\n");
};

export const toRss = (posts: Post[], { siteUrl, title, description }: FeedOptions) => {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${escapeXml(itemTitle(p))}</title>
      <link>${escapeXml(permalink(siteUrl, p.id))}</link>
      <guid isPermaLink="true">${escapeXml(permalink(siteUrl, p.id))}</guid>
      <dc:creator>${escapeXml(p.author.displayName)}</dc:creator>
      <pubDate>${new Date(p.createdAt).toUTCString()}</pubDate>
      <description><![CDATA[${itemHtml(p, siteUrl)}]]></description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}/</link>
    <atom:link href="${escapeXml(siteUrl)}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
};

export const toJsonFeed = (posts: Post[], { siteUrl, title, description }: FeedOptions) =>
  JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title,
      description,
      home_page_url: `${siteUrl}/`,
      feed_url: `${siteUrl}/feed.json`,
      items: posts.map((p) => ({
        id: permalink(siteUrl, p.id),
        url: permalink(siteUrl, p.id),
        ...(p.link ? { external_url: p.link } : {}),
        title: itemTitle(p),
        content_html: itemHtml(p, siteUrl),
        content_text: p.text,
        authors: [{ name: p.author.displayName, url: `${siteUrl}/u/${p.author.username}` }],
        ...(p.preview?.image ? { image: absolute(siteUrl, p.preview.image) } : {}),
        date_published: p.createdAt,
      })),
    },
    null,
    2
  );
