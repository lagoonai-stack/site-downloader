import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { fileURLToPath } from "url";
import path from "path";
import { promises as fsp } from "fs";
import os from "os";
import { build as esbuildBuild } from "esbuild";

import authRoutes from "./authRoutes.js";
import kiwifyWebhook from "./kiwifyWebhook.js";
import { requireActiveSubscriber } from "./requireActiveSubscriber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Atras do proxy reverso do Dokploy (Traefik): confia so no primeiro
// hop pra pegar o IP real do cliente via X-Forwarded-For, sem o que
// o rate-limit (por IP) nao consegue identificar os visitantes direito.
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/webhooks", kiwifyWebhook);

app.use("/api/auth", authRoutes);

app.get("/login.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "login.html"))
);
app.get("/login.js", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "login.js"))
);
app.get("/styles.css", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "styles.css"))
);

app.use(requireActiveSubscriber);

app.use(express.static(path.join(__dirname, "public")));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchBuffer(url) {
  try {
    const { data } = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      maxRedirects: 5,
      headers: { "User-Agent": UA },
    });
    return Buffer.from(data);
  } catch {
    return null;
  }
}

async function getHtml(url, useSpa) {
  if (useSpa) {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const html = await page.content();
    await browser.close();
    return html;
  }
  const { data } = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: { "User-Agent": UA },
  });
  return data;
}

function localName(resUrl, folder, seen) {
  let name = path.basename(new URL(resUrl).pathname) || "index";
  name = name.split("?")[0].split("#")[0] || "file";
  if (!path.extname(name)) name += folder === "css" ? ".css" : folder === "js" ? ".js" : "";
  let final = `${folder}/${name}`;
  let i = 1;
  while (seen.has(final)) {
    const ext = path.extname(name);
    final = `${folder}/${path.basename(name, ext)}_${i++}${ext}`;
  }
  seen.add(final);
  return final;
}

// Bundlers como Vite marcam chunks carregados sob demanda (React.lazy,
// import() dinamico) com o nome do arquivo escrito em texto dentro do
// bundle - mesmo que o navegador so peca esse arquivo quando alguem
// realmente clica em algo (o que nunca acontece no carregamento unico
// que o Puppeteer faz). Aqui a gente varre o texto de cada JS ja
// baixado atras desses imports e busca os arquivos direto, recursivamente,
// pra nao depender de "visitar" cada tela do site pra descobrir os chunks.
async function crawlJsImports(initialResults, seen) {
  const known = new Map();
  for (const r of initialResults) known.set(r.absUrl, r);

  const queue = initialResults
    .filter((r) => r.local.startsWith("js/") && r.buf)
    .map((r) => r.absUrl);

  while (queue.length > 0) {
    const abs = queue.shift();
    const entry = known.get(abs);
    if (!entry?.buf) continue;

    const text = entry.buf.toString("utf8");
    const specs = new Set();
    for (const m of text.matchAll(/import\(\s*["'`](\.[^"'`]+?\.js)["'`]\s*\)/g)) {
      specs.add(m[1]);
    }
    for (const m of text.matchAll(/\bfrom\s*["'`](\.[^"'`]+?\.js)["'`]/g)) {
      specs.add(m[1]);
    }

    for (const spec of specs) {
      let resolvedAbs;
      try {
        resolvedAbs = new URL(spec, abs).href;
      } catch {
        continue;
      }
      if (known.has(resolvedAbs)) continue;

      const buf = await fetchBuffer(resolvedAbs);
      known.set(resolvedAbs, { absUrl: resolvedAbs, local: null, buf });
      if (!buf) continue;

      const local = localName(resolvedAbs, "js", seen);
      known.set(resolvedAbs, { absUrl: resolvedAbs, local, buf });
      queue.push(resolvedAbs);
    }
  }

  return Array.from(known.values()).filter((r) => r.local);
}

// Reescreve cada <script type="module" src="..."> como um bundle unico
// em formato classico (iife), resolvendo os imports a partir dos arquivos
// ja baixados em disco. O que for absorvido pelo bundle sai da lista de
// resultados; o resto (CSS, imagens, JS nao-modulo) continua igual.
async function bundleModuleEntries({ $, moduleEntries, modulePreloadChunks, results }) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "site-downloader-"));
  try {
    for (const r of results) {
      if (!r.buf) continue;
      const dest = path.join(tempDir, r.local);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, r.buf);
    }

    const absorbed = new Set();
    const bundles = [];

    for (const [i, { el, local }] of moduleEntries.entries()) {
      const entryPath = path.join(tempDir, local);
      const bundleLocal = `js/bundle-${i}.js`;
      const outPath = path.join(tempDir, bundleLocal);

      await esbuildBuild({
        entryPoints: [entryPath],
        bundle: true,
        format: "iife",
        outfile: outPath,
        absWorkingDir: tempDir,
        logLevel: "silent",
        loader: {
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".jpeg": "dataurl",
          ".gif": "dataurl",
          ".svg": "dataurl",
          ".webp": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
          ".ttf": "dataurl",
          ".otf": "dataurl",
          ".css": "empty",
        },
      });

      bundles.push({ local: bundleLocal, buf: await fsp.readFile(outPath) });
      absorbed.add(local);
      // "defer" no lugar do comportamento implicito que type="module" tinha:
      // sem isso, um <script> comum no <head> roda antes do <body> (e da
      // div#root) existir no DOM.
      $(el)
        .removeAttr("type")
        .removeAttr("crossorigin")
        .removeAttr("integrity")
        .attr("src", bundleLocal)
        .attr("defer", "");
    }

    for (const { el, local } of modulePreloadChunks) {
      $(el).remove();
      absorbed.add(local);
    }

    return [...results.filter((r) => !absorbed.has(r.local)), ...bundles];
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

app.get("/download", async (req, res) => {
  const target = req.query.url;
  const useSpa = req.query.spa === "1";
  if (!target) return res.status(400).send("Falta o parametro ?url=");

  let base;
  try {
    base = new URL(target);
  } catch {
    return res.status(400).send("URL invalida");
  }

  try {
    const html = await getHtml(target, useSpa);
    const $ = cheerio.load(html);
    const seen = new Set();
    const jobs = [];

    // crossorigin/integrity forcam modo CORS na requisicao, que o
    // navegador sempre recusa em paginas abertas via file:// (origem
    // "null") - mesmo pro arquivo estando bem ao lado. Sem sentido pra
    // um espelho local, entao removemos ao reescrever pro caminho local.
    const dropCrossOrigin = (el) => $(el).removeAttr("crossorigin").removeAttr("integrity");

    // CSS
    $('link[rel="stylesheet"], link[as="style"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = new URL(href, base).href;
      const local = localName(abs, "css", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("href", local);
      dropCrossOrigin(el);
    });

    // JS
    const moduleEntries = [];
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (!src) return;
      const abs = new URL(src, base).href;
      const local = localName(abs, "js", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
      dropCrossOrigin(el);
      if ($(el).attr("type") === "module") {
        moduleEntries.push({ el, local });
      }
    });

    // Modulepreload/preload de scripts (Vite/React e outros bundlers com
    // code-splitting expõem os chunks JS assim, não como <script src>)
    const modulePreloadChunks = [];
    $('link[rel="modulepreload"], link[rel="preload"][as="script"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = new URL(href, base).href;
      const local = localName(abs, "js", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("href", local);
      dropCrossOrigin(el);
      modulePreloadChunks.push({ el, local });
    });

    // Imagens
    $("img[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (!src || src.startsWith("data:")) return;
      const abs = new URL(src, base).href;
      const local = localName(abs, "img", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
    });

    // Baixa todos os recursos em paralelo
    let results = await Promise.all(
      jobs.map(async (j) => ({ ...j, buf: await fetchBuffer(j.absUrl) }))
    );

    // Busca tambem os chunks carregados sob demanda (nao aparecem no HTML,
    // so referenciados em texto dentro dos JS ja baixados).
    if (useSpa) {
      try {
        results = await crawlJsImports(results, seen);
      } catch (err) {
        console.error("Falha ao expandir dependencias JS:", err.message);
      }
    }

    // Empacota os scripts type="module" num script classico, pra dar pra
    // abrir o index.html direto com duplo-clique (navegadores bloqueiam
    // modulos ES quando a pagina vem de file://). So no modo SPA. Se o
    // empacotamento falhar (ex: site importa algo de uma URL externa que
    // o esbuild nao consegue resolver), mantem a versao original modular
    // - o site continua baixavel, so precisa de um servidor local pra abrir.
    if (useSpa && moduleEntries.length > 0) {
      try {
        results = await bundleModuleEntries({ $, moduleEntries, modulePreloadChunks, results });
      } catch (err) {
        console.error("Falha ao empacotar JS (mantendo versao modular):", err.message);
      }
    }

    // Monta o ZIP
    const hostname = base.hostname.replace(/[^a-z0-9.-]/gi, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${hostname}.zip"`
    );

    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.on("error", (err) => res.status(500).end(String(err)));
    zip.pipe(res);

    zip.append($.html(), { name: "index.html" });
    for (const r of results) {
      if (r.buf) zip.append(r.buf, { name: r.local });
    }
    await zip.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao baixar: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Site Downloader rodando em http://localhost:${PORT}`)
);
