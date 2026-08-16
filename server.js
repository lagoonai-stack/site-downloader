import "dotenv/config";
import express from "express";
import helmet from "helmet";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { fileURLToPath } from "url";
import path from "path";
import { promises as fsp } from "fs";
import os from "os";
import { build as esbuildBuild } from "esbuild";

import kiwifyWebhook from "./kiwifyWebhook.js";
import { requireBraboSpaceUser } from "./requireBraboSpaceUser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Atras do proxy reverso do Dokploy (Traefik): confia so no primeiro
// hop pra pegar o IP real do cliente via X-Forwarded-For, sem o que
// o rate-limit (por IP) nao consegue identificar os visitantes direito.
app.set("trust proxy", 1);

// As previas em /previews sao HTML baixado de sites de terceiros (nao
// gerado por nos) e costuma trazer <script> inline - o CSP padrao do
// helmet bloquearia essa execucao.
const helmetMiddleware = helmet();
app.use((req, res, next) => {
  if (req.path.startsWith("/previews/")) return next();
  return helmetMiddleware(req, res, next);
});
app.use(express.json({ limit: "100kb" }));

app.use("/webhooks", kiwifyWebhook);

// thumbs/previews sao so espelhos de sites de template ja publicos (a URL real ja aparece em
// catalog.json) - deixar sem gate evita ter que autenticar toda tag <img>/<a target="_blank">
// do front. O que de fato importa proteger e a lista completa (catalog.json) e o scraping
// pesado (/download) - esses dois exigem sessao valida da BraboSpace, ver abaixo.
app.use("/thumbs", express.static(path.join(__dirname, "public", "thumbs")));
app.use("/previews", express.static(path.join(__dirname, "public", "previews")));

app.use(requireBraboSpaceUser);

app.get("/catalog.json", (req, res) => res.sendFile(path.join(__dirname, "public", "catalog.json")));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Casa url(...) em CSS, com ou sem aspas.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1?\s*\)/g;

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
    // Import() dinamico disparado em runtime (lazy-loading real) nao
    // aparece como <script>/<link modulepreload> no HTML final - a unica
    // forma confiavel de saber quais arquivos o site realmente usa e
    // registrar as requisicoes de rede de verdade durante o carregamento.
    // Guardamos o Request inteiro (nao so a URL) porque precisamos saber
    // de qual FRAME cada requisicao veio - filtramos isso depois de
    // decidir qual frame e o "de verdade" (ver mais abaixo).
    const seenRequests = [];
    page.on("request", (req) => seenRequests.push(req));
    await page.setUserAgent(UA);
    // Alguns sites tem uma conexao (chat widget, websocket, polling de
    // analytics) que nunca "esfria", entao networkidle2 as vezes nunca
    // dispara. Se isso acontecer, a pagina normalmente ja carregou tudo
    // que interessa mesmo assim - so seguimos em frente.
    await page
      .goto(url, { waitUntil: "networkidle2", timeout: 30000 })
      .catch((err) => console.warn("Aviso: goto nao atingiu networkidle2:", err.message));

    // Alguns construtores de site (Aura, etc.) sao so um "wrapper": a
    // pagina principal e so a ferramenta do construtor, e o site de
    // verdade e renderizado dentro de um <iframe srcdoc="...">, que so
    // aparece alguns segundos depois do carregamento inicial. Detectamos
    // isso especificamente por srcdoc (nao por "qualquer iframe"), pra
    // nao confundir com iframes normais de terceiros (chat, pixel de
    // rastreamento, mapa incorporado, etc.) que quase todo site tem.
    let targetFrame = page.mainFrame();
    const frameDeadline = Date.now() + 20000;
    while (Date.now() < frameDeadline) {
      const child = page.frames().find((f) => f.url() === "about:srcdoc");
      if (child) {
        targetFrame = child;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    await new Promise((r) => setTimeout(r, 1500));
    await targetFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const html = await targetFrame.content();

    // So as requisicoes feitas pelo frame que a gente de fato usou. Sem
    // isso, quando o site e um "wrapper com iframe" (Aura), o zip vinha
    // lotado de centenas de arquivos JS da ferramenta do construtor -
    // que fez suas proprias requisicoes por fora, mas nao tem nada a
    // ver com o site do usuario.
    const requestedUrls = Array.from(
      new Set(
        seenRequests
          .filter((r) => {
            try {
              return r.frame() === targetFrame;
            } catch {
              return false;
            }
          })
          .map((r) => r.url())
      )
    );

    await browser.close();
    return { html, requestedUrls };
  }
  const { data } = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: { "User-Agent": UA },
  });
  return { html: data, requestedUrls: [] };
}

// Tudo (JS, CSS, imagens) cai numa unica pasta assets/, igual a
// estrutura que a maioria das ferramentas de download de site usa
// (index.html + assets/). "folder" so serve mais pra decidir a
// extensao padrao quando o nome do arquivo original nao tem uma.
function localName(resUrl, folder, seen) {
  let name = path.basename(new URL(resUrl).pathname) || "index";
  name = name.split("?")[0].split("#")[0] || "file";
  if (!path.extname(name)) name += folder === "css" ? ".css" : folder === "js" ? ".js" : "";
  let final = `assets/${name}`;
  let i = 1;
  while (seen.has(final)) {
    const ext = path.extname(name);
    final = `assets/${path.basename(name, ext)}_${i++}${ext}`;
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
    .filter((r) => r.buf && /\.m?js$/i.test(r.local))
    .map((r) => r.absUrl);

  while (queue.length > 0) {
    const abs = queue.shift();
    const entry = known.get(abs);
    if (!entry?.buf) continue;

    const text = entry.buf.toString("utf8");
    const specs = new Set();
    // Especificador relativo ("./x.js"), absoluto de raiz ("/assets/x.js"),
    // ou "nu" tipo "assets/x.js" - esse ultimo e como o Vite guarda seu
    // mapa interno de dependencias de chunk (nao e uma chamada import()
    // de verdade, e um array de strings com o nome de todo mundo).
    for (const m of text.matchAll(/import\(\s*["'`]((?:\.{1,2}\/|\/)[^"'`]+?\.m?js)["'`]\s*\)/g)) {
      specs.add(m[1]);
    }
    for (const m of text.matchAll(/\bfrom\s*["'`]((?:\.{1,2}\/|\/)[^"'`]+?\.m?js)["'`]/g)) {
      specs.add(m[1]);
    }
    for (const m of text.matchAll(/["'`](assets\/[^"'`]+?\.(?:m?js|css))["'`]/g)) {
      specs.add(m[1]);
    }
    // require()/import() de uma URL absoluta de OUTRO dominio (comum em
    // sites feitos com Framer, que puxa chunks compartilhados do proprio
    // CDN dele em runtime). Guardamos a URL como veio (ja e absoluta).
    for (const m of text.matchAll(/(?:require|import)\(\s*["'`](https?:\/\/[^"'`]+?\.m?js)["'`]\s*\)/g)) {
      specs.add(m[1]);
    }

    for (const spec of specs) {
      let resolvedAbs;
      try {
        const normalized = /^https?:\/\//.test(spec) || /^\.{0,2}\//.test(spec) ? spec : `/${spec}`;
        resolvedAbs = new URL(normalized, abs).href;
      } catch {
        continue;
      }
      if (known.has(resolvedAbs)) continue;

      const buf = await fetchBuffer(resolvedAbs);
      known.set(resolvedAbs, { absUrl: resolvedAbs, local: null, buf });
      if (!buf) continue;

      const folder = resolvedAbs.endsWith(".css") ? "css" : "js";
      const local = localName(resolvedAbs, folder, seen);
      known.set(resolvedAbs, { absUrl: resolvedAbs, local, buf });
      queue.push(resolvedAbs);
    }
  }

  return Array.from(known.values()).filter((r) => r.local);
}

// Varre cada CSS ja baixado atras de url(...) - imagens de background,
// fontes (@font-face) etc. O navegador busca isso sozinho quando roda
// de verdade, mas um crawler baseado so no HTML nunca ve essas
// referencias porque elas vivem dentro do texto do CSS, nao em atributo
// de tag. Baixa o que falta e reescreve o CSS pra apontar pro arquivo
// local (relativo, ja que tudo vive junto em assets/).
async function crawlCssUrls(results, seen) {
  const known = new Map();
  for (const r of results) known.set(r.absUrl, r);

  const cssTargets = results.filter((r) => r.buf && r.local.endsWith(".css"));

  for (const cssResult of cssTargets) {
    const refs = [...cssResult.buf.toString("utf8").matchAll(CSS_URL_RE)]
      .map((m) => m[2].trim())
      .filter((raw) => raw && !raw.startsWith("data:") && !raw.startsWith("#"));

    for (const raw of refs) {
      let abs;
      try {
        abs = new URL(raw, cssResult.absUrl).href;
      } catch {
        continue;
      }
      if (known.has(abs)) continue;

      const buf = await fetchBuffer(abs);
      known.set(abs, { absUrl: abs, local: null, buf });
      if (!buf) continue;

      const local = localName(abs, "img", seen);
      known.set(abs, { absUrl: abs, local, buf });
    }

    const text = cssResult.buf.toString("utf8").replace(CSS_URL_RE, (full, _quote, raw) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) return full;
      let abs;
      try {
        abs = new URL(trimmed, cssResult.absUrl).href;
      } catch {
        return full;
      }
      const entry = known.get(abs);
      if (!entry?.local) return full;
      return `url(${path.basename(entry.local)})`;
    });
    cssResult.buf = Buffer.from(text, "utf8");
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
    // Se algum arquivo foi baixado a partir de uma URL absoluta (ex: um
    // chunk do CDN do Framer, referenciado via require("https://...")),
    // troca essa URL pelo caminho relativo local no texto de TODOS os
    // arquivos antes de escrever em disco - assim o esbuild acha um
    // require()/import() resolvivel em vez da URL externa original.
    const externalRewrites = results
      .filter((r) => r.buf && /^https?:\/\//.test(r.absUrl) && /\.m?js$/i.test(r.local || ""))
      .map((r) => [r.absUrl, `./${path.basename(r.local)}`]);

    for (const r of results) {
      if (!r.buf) continue;
      let buf = r.buf;
      if (externalRewrites.length > 0 && r.local.endsWith(".js")) {
        let text = buf.toString("utf8");
        let changed = false;
        for (const [url, localRel] of externalRewrites) {
          if (text.includes(url)) {
            text = text.split(url).join(localRel);
            changed = true;
          }
        }
        if (changed) buf = Buffer.from(text, "utf8");
      }
      const dest = path.join(tempDir, r.local);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    }

    const absorbed = new Set();
    const bundles = [];

    for (const [i, { el, local }] of moduleEntries.entries()) {
      const entryPath = path.join(tempDir, local);
      const bundleLocal = `assets/bundle-${i}.js`;
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

// Decide sozinho se o site precisa de renderizacao via Puppeteer.
// So texto curto no <body> nao basta (um site estatico simples, tipo
// example.com, tambem tem pouco texto) - o sinal confiavel e uma div
// raiz tipica de SPA (#root, #app, etc.) vazia, ou um script
// type="module" combinado com quase nenhum texto visivel.
function looksLikeEmptyShell(html) {
  const $ = cheerio.load(html);

  const hasEmptyRootDiv = $("#root, #app, #__next, #___gatsby, #svelte")
    .toArray()
    .some((el) => $(el).children().length === 0 && $(el).text().trim().length === 0);
  if (hasEmptyRootDiv) return true;

  const hasModuleScript = $('script[type="module"]').length > 0;

  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();

  if (text.length < 40) return true;
  return hasModuleScript && text.length < 200;
}

async function detectNeedsSpa(target) {
  try {
    const { data } = await axios.get(target, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { "User-Agent": UA },
    });
    return looksLikeEmptyShell(data);
  } catch {
    // se nem a busca simples funcionar, tenta o caminho mais robusto
    return true;
  }
}

app.get("/download", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Falta o parametro ?url=");

  let base;
  try {
    base = new URL(target);
  } catch {
    return res.status(400).send("URL invalida");
  }

  try {
    const useSpa = await detectNeedsSpa(target);
    const { html, requestedUrls } = await getHtml(target, useSpa);
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

    // CSS inline (<style> e atributo style="") tambem referencia imagem/
    // fonte via url(...) - o navegador so busca essas imagens de fundo
    // via CSS, entao sem isso elas desaparecem silenciosamente da copia
    // (nao contam como <img> quebrada, mas o efeito visual falta).
    const rewriteInlineCssUrls = (cssText) =>
      cssText.replace(CSS_URL_RE, (full, _quote, raw) => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) return full;
        let abs;
        try {
          abs = new URL(trimmed, base).href;
        } catch {
          return full;
        }
        const local = localName(abs, "img", seen);
        jobs.push({ absUrl: abs, local });
        return `url(${local})`;
      });

    $("style").each((_, el) => {
      const text = $(el).html();
      if (text && text.includes("url(")) $(el).html(rewriteInlineCssUrls(text));
    });
    $("[style]").each((_, el) => {
      const styleAttr = $(el).attr("style");
      if (styleAttr && styleAttr.includes("url(")) $(el).attr("style", rewriteInlineCssUrls(styleAttr));
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

    // Imagens (src + srcset - o navegador so busca a variante que casa
    // com o viewport atual, mas o arquivo baixado deve funcionar em
    // qualquer tela, entao baixamos todas as variantes listadas)
    $("img[src], img[srcset], source[srcset]").each((_, el) => {
      const src = $(el).attr("src");
      if (src && !src.startsWith("data:")) {
        const abs = new URL(src, base).href;
        const local = localName(abs, "img", seen);
        jobs.push({ absUrl: abs, local });
        $(el).attr("src", local);
      }

      const srcset = $(el).attr("srcset");
      if (srcset) {
        const rewritten = srcset
          .split(",")
          .map((part) => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.search(/\s/);
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const descriptor = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
            if (!url || url.startsWith("data:")) return trimmed;
            const abs = new URL(url, base).href;
            const local = localName(abs, "img", seen);
            jobs.push({ absUrl: abs, local });
            return `${local}${descriptor}`;
          })
          .join(", ");
        $(el).attr("srcset", rewritten);
      }
    });

    // Video/audio (src, poster, e <source> dentro deles)
    $("video[src], audio[src], video source[src], audio source[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (!src || src.startsWith("data:")) return;
      const abs = new URL(src, base).href;
      const local = localName(abs, "img", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
    });
    $("video[poster]").each((_, el) => {
      const poster = $(el).attr("poster");
      if (!poster || poster.startsWith("data:")) return;
      const abs = new URL(poster, base).href;
      const local = localName(abs, "img", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("poster", local);
    });

    // Requisicoes que o navegador realmente fez durante o carregamento
    // (page.on("request")) sem tag correspondente no HTML - cobre chunks
    // JS carregados via import() em runtime, CDN de terceiros (React,
    // Babel etc. carregados via <script> dinamico), video/imagem/fonte
    // que so aparecem via CSS ou logica JS. Nao restringe mais por
    // dominio nem extensao - se o frame que baixamos pediu, faz parte
    // do site de verdade (ja filtramos pra so esse frame em getHtml).
    const knownAbs = new Set(jobs.map((j) => j.absUrl));
    const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
    for (const reqUrl of requestedUrls) {
      let u;
      try {
        u = new URL(reqUrl);
      } catch {
        continue;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (u.href === base.href) continue;
      if (knownAbs.has(u.href)) continue;

      const folder = u.pathname.endsWith(".css")
        ? "css"
        : IMG_EXT.test(u.pathname)
        ? "img"
        : "js";
      const local = localName(u.href, folder, seen);
      jobs.push({ absUrl: u.href, local });
      knownAbs.add(u.href);
    }

    // Baixa todos os recursos em paralelo
    let results = await Promise.all(
      jobs.map(async (j) => ({ ...j, buf: await fetchBuffer(j.absUrl) }))
    );

    // Busca tambem os chunks carregados sob demanda (nao aparecem no HTML,
    // so referenciados em texto dentro dos JS ja baixados). Isso vale
    // independente de ter usado Puppeteer ou nao - um site pode ja vir
    // com texto suficiente no HTML puro (Framer, por exemplo, pre-
    // renderiza pro SEO) e mesmo assim ter <script type="module"> que
    // precisa ser empacotado pra funcionar offline.
    try {
      results = await crawlJsImports(results, seen);
    } catch (err) {
      console.error("Falha ao expandir dependencias JS:", err.message);
    }

    // Mesma logica pra CSS: imagem de fundo, fonte @font-face etc.
    // referenciadas via url(...) dentro do arquivo .css baixado.
    try {
      results = await crawlCssUrls(results, seen);
    } catch (err) {
      console.error("Falha ao expandir url() do CSS:", err.message);
    }

    // Empacota os scripts type="module" num script classico, pra dar pra
    // abrir o index.html direto com duplo-clique (navegadores bloqueiam
    // modulos ES quando a pagina vem de file://), sempre que existir
    // algum. Se o empacotamento falhar (ex: site importa algo de uma URL
    // externa que o esbuild nao consegue resolver), mantem a versao
    // original modular - o site continua baixavel, so precisa de um
    // servidor local pra abrir.
    if (moduleEntries.length > 0) {
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
