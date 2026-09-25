const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const scraper = require("./src/scraper");

const PORT = Number(process.env.PORT || 7000);

const manifest = {
  id: "com.xonados.novela",
  version: "1.0.0",
  name: "Xonados Novelas",
  description: "Xonados novela catalog for Stremio.",
  logo: "https://www.xonados.com/icon.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [{
    type: "series",
    id: "xonados-novelas",
    name: "Novelas",
    extra: [{ name: "search", isRequired: false }]
  }]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  if (type !== "series" || id !== "xonados-novelas") return { metas: [] };
  return { metas: await scraper.getNovelas(extra.search || "") };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series") return { meta: null };
  return { meta: await scraper.getNovelaById(id) };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series") return { streams: [] };
  const stream = await scraper.resolveEpisode(id);
  return stream ? { streams: [stream] } : { streams: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log("Xonados Stremio addon listening on port", PORT);
