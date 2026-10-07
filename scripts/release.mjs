import { CLOUDFLARE_SITE_URL, cloudflarePolicy } from "./cloudflare.mjs";

export const PAGE_PATHS = Object.freeze(["index.html", "en/index.html"]);

const PAGE_CONTENT = Object.freeze({
  "index.html": Object.freeze({
    language: "zh-Hant",
    openGraphLocale: "zh_TW",
    title: "配色工具與文字對比檢查｜GlossQuote Labs",
    description: "手動整理 2 至 8 色色票，轉換 HEX、RGB、HSL，檢查不透明 sRGB 文字與背景的對比值。",
  }),
  "en/index.html": Object.freeze({
    language: "en",
    openGraphLocale: "en_US",
    title: "Color Palette and Text Contrast | GlossQuote Labs",
    description: "Build a 2 to 8 color palette, edit HEX, RGB, or HSL values, and check text contrast between opaque sRGB colors.",
  }),
});

function blank(text) {
  return " ".repeat(text.length);
}

function uncommentedMarkup(html) {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/gu, blank);
}

function activeMarkup(html) {
  const uncommented = uncommentedMarkup(html);
  return uncommented.replace(
    /<(script|style|title|textarea|template|noscript|xmp|iframe|noembed|noframes|plaintext)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu,
    blank,
  );
}

function titleMarkup(html) {
  const uncommented = uncommentedMarkup(html);
  return uncommented.replace(
    /<(script|style|textarea|template|noscript|xmp|iframe|noembed|noframes|plaintext)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu,
    blank,
  );
}

function activeHead(html) {
  const active = activeMarkup(html);
  const heads = [...active.matchAll(/<head\b[^>]*>[\s\S]*?<\/head\s*>/giu)];
  if (heads.length !== 1) throw new Error("SEO metadata requires exactly one active document head.");
  return { active, head: heads[0] };
}

function findMetaAndLinkTags(active) {
  return [...active.matchAll(/<(?:meta|link)\b[^>]*>/giu)].filter(([tag]) =>
    /\b(?:name|property|rel)\s*=\s*["']?(?:robots|description|canonical|alternate|og:[a-z_]+)\b/iu.test(tag));
}

function headTitle(html, page) {
  const active = titleMarkup(html);
  const heads = [...active.matchAll(/<head\b[^>]*>[\s\S]*?<\/head\s*>/giu)];
  if (heads.length !== 1) throw new Error("SEO metadata requires exactly one active document head.");
  const head = heads[0];
  const titles = [...active.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/giu)];
  if (titles.length !== 1 || titles[0].index < head.index || titles[0].index >= head.index + head[0].length) {
    throw new Error(`${page} must contain one title in its active document head.`);
  }
  const titleTag = titles[0];
  const originalTitle = html.slice(titleTag.index, titleTag.index + titleTag[0].length);
  const text = originalTitle.replace(/<title\b[^>]*>|<\/title\s*>/giu, "").trim();
  if (!text || /[<>]/u.test(text)) throw new Error(`${page} has an invalid title.`);
  return text;
}

function expectedPreviewSeo(page) {
  const content = PAGE_CONTENT[page];
  if (!content) throw new Error("Unknown language page.");
  const alternate = page === "index.html"
    ? [
      '<link rel="alternate" hreflang="en" href="./en/index.html">',
      '<link rel="alternate" hreflang="zh-Hant" href="./index.html">',
    ]
    : [
      '<link rel="alternate" hreflang="zh-Hant" href="../index.html">',
      '<link rel="alternate" hreflang="en" href="./index.html">',
    ];
  return [
    '<meta name="robots" content="noindex, nofollow">',
    `<meta name="description" content="${content.description}">`,
    ...alternate,
  ];
}

function exactMetadataTags(html, expected, label) {
  const { active, head } = activeHead(html);
  const tags = findMetaAndLinkTags(active);
  if (tags.length !== expected.length || expected.some((expectedTag) =>
    tags.filter(([tag]) => tag === expectedTag).length !== 1)) {
    throw new Error(`${label} metadata differs from the exact expected set.`);
  }
  if (tags.some((tag) => tag.index < head.index || tag.index >= head.index + head[0].length)) {
    throw new Error(`${label} metadata must occur in the active document head.`);
  }
  return tags;
}

function schemaFor(page, policy) {
  const content = PAGE_CONTENT[page];
  const url = policy.urls[PAGE_PATHS.indexOf(page)];
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: content.title,
    url,
    description: content.description,
    inLanguage: content.language,
    applicationCategory: "DesignApplication",
    operatingSystem: "Any",
    isAccessibleForFree: true,
    browserRequirements: "Requires JavaScript for interactive editing and calculations.",
  };
}

function jsonScript(page, policy) {
  const json = JSON.stringify(schemaFor(page, policy)).replace(/</gu, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

function productionSeoTags(page, policy) {
  const content = PAGE_CONTENT[page];
  const canonical = policy.urls[PAGE_PATHS.indexOf(page)];
  const otherLocale = page === "index.html" ? "en_US" : "zh_TW";
  return [
    '<meta name="robots" content="index, follow">',
    `<meta name="description" content="${content.description}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<link rel="alternate" hreflang="zh-Hant" href="${policy.urls[0]}">`,
    `<link rel="alternate" hreflang="en" href="${policy.urls[1]}">`,
    `<link rel="alternate" hreflang="x-default" href="${policy.urls[0]}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="GlossQuote Labs">',
    `<meta property="og:title" content="${content.title}">`,
    `<meta property="og:description" content="${content.description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:locale" content="${content.openGraphLocale}">`,
    `<meta property="og:locale:alternate" content="${otherLocale}">`,
  ];
}

function productionJsonLdTags(html, page, policy) {
  const candidates = [...uncommentedMarkup(html).matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu)];
  const expected = jsonScript(page, policy);
  const inline = candidates.filter(([, attributes]) => !/\bsrc(?:\s|=|>|$)/iu.test(attributes));
  const exact = inline.filter(([tag]) => tag === expected);
  if (exact.length !== 1 || inline.length !== 1) {
    throw new Error(`${page} must contain only the exact controlled WebApplication JSON-LD block.`);
  }
  return exact;
}

export function releasePolicy(siteUrl) {
  if (typeof siteUrl !== "string" || siteUrl !== CLOUDFLARE_SITE_URL) {
    throw new Error(`Production requires --site-url ${CLOUDFLARE_SITE_URL}`);
  }
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("site-url must be the exact HTTPS origin with a trailing slash.");
  }
  const urls = PAGE_PATHS.map((path) => new URL(path, url).href);
  const files = new Map([
    ["robots.txt", `User-agent: *\nAllow: /\nSitemap: ${url.href}sitemap.xml\n`],
    ["sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((entry) => `  <url><loc>${entry}</loc></url>`).join("\n") + "\n</urlset>\n"],
  ]);
  return { base: url.href, urls, files, links: (page) => productionSeoTags(page, { urls }) };
}

export function parseReleaseArgs(args) {
  if (args.length === 0) return { production: false };
  let production = false;
  let cloudflare = false;
  let siteUrl;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--production") {
      if (production) throw new Error("Duplicate --production flag.");
      production = true;
    } else if (argument === "--cloudflare") {
      if (cloudflare) throw new Error("Duplicate --cloudflare flag.");
      cloudflare = true;
    } else if (argument === "--site-url") {
      if (siteUrl !== undefined || index + 1 >= args.length) {
        throw new Error("--site-url requires one URL value.");
      }
      siteUrl = args[index + 1];
      index += 1;
    } else {
      throw new Error("Unknown release argument.");
    }
  }
  if (!production || !cloudflare || siteUrl === undefined) {
    throw new Error("Production requires --production, --cloudflare, and --site-url.");
  }
  releasePolicy(siteUrl);
  cloudflarePolicy(siteUrl);
  return { production, cloudflare, siteUrl };
}

export function previewSeoTags(page) {
  return expectedPreviewSeo(page);
}

export function expectedJsonLd(page, policy) {
  return jsonScript(page, policy);
}

export function assertPreviewHtml(html, page) {
  if (headTitle(html, page) !== PAGE_CONTENT[page]?.title) {
    throw new Error(`${page} title differs from the expected localized title.`);
  }
  exactMetadataTags(html, expectedPreviewSeo(page), "Preview");
  if (/colors\.glossquote\.com|rel\s*=\s*["']canonical|application\/ld\+json|property\s*=\s*["']og:/iu.test(activeMarkup(html))) {
    throw new Error(`${page} preview must not include production SEO metadata.`);
  }
}

export function productionHtml(html, page, policy) {
  if (!PAGE_CONTENT[page]) throw new Error("Unknown language page.");
  assertPreviewHtml(html, page);
  const sourceTags = exactMetadataTags(html, expectedPreviewSeo(page), "Preview");
  const replacementTags = productionSeoTags(page, policy);
  const block = [...replacementTags, jsonScript(page, policy)].join("\n  ");
  let output = html;
  for (const entry of [...sourceTags].sort((left, right) => right.index - left.index)) {
    const [tag] = entry;
    output = `${output.slice(0, entry.index)}${output.slice(entry.index + tag.length)}`;
  }
  const opening = /<head\b[^>]*>/iu.exec(activeMarkup(html));
  if (!opening) throw new Error("Production SEO metadata requires a document head.");
  const insertionPoint = opening.index + opening[0].length;
  output = `${output.slice(0, insertionPoint)}\n  ${block}${output.slice(insertionPoint)}`;
  assertProductionHtml(output, page, policy);
  return output;
}

export function assertProductionHtml(html, page, policy) {
  if (!PAGE_CONTENT[page]) throw new Error("Unknown language page.");
  if (headTitle(html, page) !== PAGE_CONTENT[page].title) {
    throw new Error(`${page} title differs from the expected localized title.`);
  }
  exactMetadataTags(html, [
    ...productionSeoTags(page, policy),
  ], "Production");
  productionJsonLdTags(html, page, policy);
  if (/noindex|nofollow/iu.test(activeMarkup(html))) {
    throw new Error(`${page} production output cannot be marked noindex or nofollow.`);
  }
}
