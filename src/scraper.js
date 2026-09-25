const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.xonados.com";
const HOST = new URL(BASE_URL).hostname;

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  }
});

const abs = (u, base = BASE_URL) => u ? new URL(u, base).href : null;
const enc = (p, u) => `xonados:${p}:${Buffer.from(u, "utf8").toString("base64url")}`;
const dec = (id, p) => {
  const m = `xonados:${p}:`;
  if (!id?.startsWith(m)) return null;
  try { return Buffer.from(id.slice(m.length), "base64url").toString("utf8"); }
  catch { return null; }
};

async function html(url) {
  const r = await client.get(url);
  return typeof r.data === "string" ? r.data : "";
}

function uniqueBy(items, key) {
  return [...new Map(items.map(x => [key(x), x])).values()];
}

function sameSite(url) {
  try { return new URL(url).hostname === HOST; } catch { return false; }
}

function titleFromLink($, el) {
  return (
    $(el).attr("title") ||
    $(el).find("[title]").first().attr("title") ||
    $(el).find("img").first().attr("alt") ||
    $(el).find("img").first().attr("title") ||
    $(el).text().replace(/\s+/g, " ").trim()
  ).trim();
}

function isNovelaUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === HOST && /@novela\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function parseNovelaLinks(pageHtml, pageUrl = BASE_URL) {
  const $ = cheerio.load(pageHtml);
  const items = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const url = abs(href, pageUrl);
    if (!url || !isNovelaUrl(url)) return;

    const name = titleFromLink($, el);
    if (!name || name.length < 2) return;

    const poster = abs(
      $(el).find("img").first().attr("src") ||
      $(el).find("img").first().attr("data-src"),
      pageUrl
    );

    items.push({
      id: enc("novela", url),
      type: "series",
      name,
      ...(poster ? { poster } : {})
    });
  });

  return uniqueBy(items, x => x.id);
}

function collectScriptUrls(pageHtml, pageUrl) {
  const $ = cheerio.load(pageHtml);
  return [...new Set(
    $("script[src]")
      .map((_, el) => abs($(el).attr("src"), pageUrl))
      .get()
      .filter(Boolean)
      .filter(sameSite)
  )];
}

function collectAstUrls(pageHtml, pageUrl) {
  const found = new Set();
  const add = value => {
    if (!value) return;
    const u = abs(value, pageUrl);
    if (u && sameSite(u) && /\/ast\//i.test(u)) found.add(u);
  };

  const $ = cheerio.load(pageHtml);
  $("script[src],iframe[src]").each((_, el) => add($(el).attr("src")));

  for (const m of pageHtml.match(/(?:https?:\/\/[^"'\s]+)?\/ast\/[^"'\s<)]+/gi) || []) {
    add(m);
  }

  return [...found];
}

function episodeFrames(pageHtml, pageUrl) {
  const $ = cheerio.load(pageHtml);
  const out = [];

  $(".mono_type").each((_, el) => {
    const date = $(el).attr("data-ts") || "";
    const src = $(el).find("iframe").first().attr("src");
    if (src) out.push({ date, playerUrl: abs(src, pageUrl) });
  });

  $("iframe[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (/\/ast\/OnW\//i.test(src)) {
      const u = new URL(src, pageUrl);
      out.push({
        date: u.searchParams.get("date") || "",
        playerUrl: u.href
      });
    }
  });

  const onwRe = /(?:https?:\/\/[^"'\s]+)?\/ast\/OnW\/\?(?:[^"'\s<>]+)/gi;
  for (const m of pageHtml.match(onwRe) || []) {
    try {
      const u = new URL(m, pageUrl);
      out.push({
        date: u.searchParams.get("date") || "",
        playerUrl: u.href
      });
    } catch {}
  }

  return uniqueBy(
    out.filter(x => x.playerUrl && sameSite(x.playerUrl)),
    x => x.playerUrl
  );
}

async function resolveEpisode(id) {
  const playerUrl = dec(id, "episode");
  if (!playerUrl || !sameSite(playerUrl)) return null;

  const page = await html(playerUrl);
  const $ = cheerio.load(page);

  const src = $("video source[src]")
    .map((_, el) => $(el).attr("src"))
    .get()
    .map(x => abs(x, playerUrl))
    .find(Boolean);

  if (!src) return null;

  const poster = abs($("video").attr("poster"), playerUrl);

  return {
    name: "Xonados",
    title: "Direct video source",
    url: src,
    behaviorHints: {
      bingeGroup: "xonados-series",
      ...(poster ? { thumbnail: poster } : {})
    }
  };
}

async function getNovelaById(id) {
  const pageUrl = dec(id, "novela");
  if (!pageUrl || !sameSite(pageUrl)) return null;

  const page = await html(pageUrl);
  const $ = cheerio.load(page);

  const name =
    $("meta[property='og:title']").attr("content") ||
    $("h1").first().text().trim() ||
    $("title").first().text().trim() ||
    "Novela";

  const description =
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    "";

  const poster = abs(
    $("meta[property='og:image']").attr("content") ||
    $("img").first().attr("src"),
    pageUrl
  );

  let eps = episodeFrames(page, pageUrl);

  const scriptUrls = collectScriptUrls(page, pageUrl);
  for (const scriptUrl of scriptUrls.slice(0, 20)) {
    try {
      const script = await html(scriptUrl);
      eps = eps.concat(episodeFrames(script, scriptUrl));

      for (const astUrl of collectAstUrls(script, scriptUrl).slice(0, 10)) {
        if (/\/ast\/OnW\//i.test(astUrl)) continue;
        try {
          eps = eps.concat(episodeFrames(await html(astUrl), astUrl));
        } catch {}
      }
    } catch {}
  }

  for (const frame of [...new Set(
    $("iframe[src]")
      .map((_, el) => abs($(el).attr("src"), pageUrl))
      .get()
      .filter(Boolean)
      .filter(sameSite)
  )].slice(0, 10)) {
    if (/\/ast\/OnW\//i.test(frame)) continue;
    try { eps = eps.concat(episodeFrames(await html(frame), frame)); } catch {}
  }

  eps = uniqueBy(
    eps.filter(e => e.playerUrl && sameSite(e.playerUrl)),
    x => x.playerUrl
  ).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  console.log("[xonados] meta", {
    pageUrl,
    scripts: scriptUrls.length,
    episodes: eps.length,
    sample: eps.slice(0, 5)
  });

  const videos = eps.map((e, i) => ({
    id: enc("episode", e.playerUrl),
    title: e.date ? `Episódio ${e.date}` : `Episódio ${i + 1}`,
    season: 1,
    episode: i + 1,
    ...(e.date && /^\d{8}$/.test(e.date)
      ? { released: `${e.date.slice(0,4)}-${e.date.slice(4,6)}-${e.date.slice(6,8)}T00:00:00.000Z` }
      : {})
  }));

  return {
    id,
    type: "series",
    name,
    poster,
    background: poster,
    description,
    videos
  };
}

async function getNovelas(search = "") {
  const root = await html("/");
  let items = parseNovelaLinks(root, BASE_URL);

  // Keep the catalog discovery that was already working: the homepage
  // links point to individual /@novela/... pages.
  const $ = cheerio.load(root);
  const candidatePages = $("a[href]")
    .map((_, el) => abs($(el).attr("href"), BASE_URL))
    .get()
    .filter(Boolean)
    .filter(isNovelaUrl)
    .filter(url => url !== BASE_URL);

  // Some pages are exposed through same-site iframes.
  const frames = $("iframe[src]")
    .map((_, el) => abs($(el).attr("src"), BASE_URL))
    .get()
    .filter(Boolean)
    .filter(sameSite);

  for (const frame of [...new Set(frames)].slice(0, 20)) {
    try { items = items.concat(parseNovelaLinks(await html(frame), frame)); } catch {}
  }

  // Crawl the novela pages linked from the homepage only as a fallback.
  // This restores the behavior that produced the working catalog.
  for (const url of [...new Set(candidatePages)].slice(0, 30)) {
    try { items = items.concat(parseNovelaLinks(await html(url), url)); } catch {}
  }

  items = uniqueBy(items, x => x.id);

  if (!search) return items.slice(0, 100);
  const q = search.toLowerCase();
  return items.filter(x => x.name.toLowerCase().includes(q)).slice(0, 100);
}

module.exports = {
  getNovelas,
  getNovelaById,
  resolveEpisode
};
