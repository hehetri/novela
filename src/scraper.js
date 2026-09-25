const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.xonados.com";

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
  return Buffer.from(id.slice(m.length), "base64url").toString("utf8");
};

async function html(url) {
  const r = await client.get(url);
  return r.data;
}

function episodeFrames(pageHtml, pageUrl) {
  const $ = cheerio.load(pageHtml);
  const out = [];
  $(".mono_type").each((_, el) => {
    const date = $(el).attr("data-ts") || "";
    const src = $(el).find("iframe").first().attr("src");
    if (src) out.push({ date, playerUrl: abs(src, pageUrl) });
  });
  if (!out.length) {
    $("iframe[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (/\/ast\/OnW\//i.test(src || "")) {
        const u = new URL(src, pageUrl);
        out.push({ date: u.searchParams.get("date") || "", playerUrl: u.href });
      }
    });
  }
  return [...new Map(out.map(x => [x.playerUrl, x])).values()];
}

async function resolveEpisode(id) {
  const playerUrl = dec(id, "episode");
  if (!playerUrl) return null;

  const page = await html(playerUrl);
  const $ = cheerio.load(page);
  const src = $("video source[src]").map((_, el) => $(el).attr("src")).get()
    .map(x => abs(x, playerUrl)).find(Boolean);
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
  if (!pageUrl) return null;

  const page = await html(pageUrl);
  const $ = cheerio.load(page);
  const name = $("meta[property='og:title']").attr("content") || $("h1").first().text().trim() || $("title").text().trim() || "Novela";
  const description = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
  const poster = abs($("meta[property='og:image']").attr("content") || $("img").first().attr("src"), pageUrl);

  const eps = episodeFrames(page, pageUrl).sort((a,b) => String(b.date).localeCompare(String(a.date)));
  const videos = eps.map((e, i) => ({
    id: enc("episode", e.playerUrl),
    title: e.date ? `Capítulo ${e.date}` : `Capítulo ${i + 1}`,
    season: 1,
    episode: i + 1,
    ...(e.date && /^\\d{8}$/.test(e.date) ? { released: `${e.date.slice(0,4)}-${e.date.slice(4,6)}-${e.date.slice(6,8)}T00:00:00.000Z` } : {})
  }));

  return { id, type: "series", name, poster, background: poster, description, videos };
}

async function getNovelas(search = "") {
  const page = await html("/");
  const $ = cheerio.load(page);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\\s+/g, " ").trim();
    if (!href || !text) return;
    const url = abs(href);
    if (/xonados\\.com\/@novela\//i.test(url)) {
      items.push({ id: enc("novela", url), type: "series", name: text });
    }
  });

  const unique = [...new Map(items.map(x => [x.id, x])).values()];
  if (!search) return unique;
  const q = search.toLowerCase();
  return unique.filter(x => x.name.toLowerCase().includes(q));
}

module.exports = { getNovelas, getNovelaById, resolveEpisode };
