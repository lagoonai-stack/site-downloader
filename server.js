import "dotenv/config";
import express from "express";
import helmet from "helmet";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import path from "path";
import { promises as fsp } from "fs";
import os from "os";
import { build as esbuildBuild } from "esbuild";

import kiwifyWebhook from "./kiwifyWebhook.js";
import { requireBraboSpaceUser } from "./requireBraboSpaceUser.js";
import { buildDesignSystem, IMAGE_EXT_RE } from "./designSystemBuilder.js";
import { createJob, getJob, cancelJob, finishJob, CancelError } from "./activeJobs.js";
import { saveDownloadHistory, listDownloadHistory, getDownloadHistorySignedUrl, deleteDownloadHistoryEntry } from "./downloadHistory.js";
import { saveErrorReport } from "./errorReports.js";

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

// Log de erro com timestamp e contexto da requisicao (url/mode), num
// formato de linha unica e greppavel ("[ERROR] ...") - facilita achar e
// correlacionar falhas nos logs do Dokploy, que por si so so mostram
// stdout/stderr cru sem estruturar nada.
function logError(label, err, context = {}) {
  const ctx = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const detail = err?.stack || err?.message || String(err);
  console.error(`[ERROR] ${new Date().toISOString()} ${label}${ctx ? " " + ctx : ""} :: ${detail}`);
}

// Casa url(...) em CSS, com ou sem aspas.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1?\s*\)/g;

async function fetchBuffer(url, signal) {
  try {
    const { data } = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      maxRedirects: 5,
      headers: { "User-Agent": UA },
      signal,
    });
    return Buffer.from(data);
  } catch (err) {
    // Cancelamento (usuario clicou "cancelar") nao e uma falha de rede -
    // se engolir e devolver null igual aos outros erros, o /download acha
    // que TODOS os assets falharam em vez de perceber que foi cancelado.
    // Normaliza pro CancelError proprio (em vez de relancar o erro cru do
    // axios) pra quem chama so precisar checar "instanceof CancelError",
    // sem se preocupar com a forma exata do erro de cancelamento do axios.
    if (axios.isCancel(err) || err.code === "ERR_CANCELED") throw new CancelError();
    return null;
  }
}

async function getHtml(url, useSpa, ctx = {}) {
  if (ctx.signal?.aborted) throw new CancelError();
  if (useSpa) {
    ctx.onProgress?.("carregando-pagina", 10, "Abrindo o navegador");
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    ctx.setBrowser?.(browser);
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
    if (ctx.signal?.aborted) throw new CancelError();

    // Alguns construtores de site (Aura, etc.) sao so um "wrapper": a
    // pagina principal e so a ferramenta do construtor, e o site de
    // verdade e renderizado dentro de um <iframe srcdoc="...">, que so
    // aparece alguns segundos depois do carregamento inicial. Detectamos
    // isso especificamente por srcdoc (nao por "qualquer iframe"), pra
    // nao confundir com iframes normais de terceiros (chat, pixel de
    // rastreamento, mapa incorporado, etc.) que quase todo site tem.
    let targetFrame = page.mainFrame();
    const frameDeadline = Date.now() + 20000;
    while (Date.now() < frameDeadline && !ctx.signal?.aborted) {
      const child = page.frames().find((f) => f.url() === "about:srcdoc");
      if (child) {
        targetFrame = child;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (ctx.signal?.aborted) throw new CancelError();
    ctx.onProgress?.("carregando-pagina", 20, "Pagina carregada, aguardando conteudo");

    await new Promise((r) => setTimeout(r, 1500));

    // Templates mais "premium" (com intro/loading screen antes do conteudo
    // de verdade aparecer) as vezes levam bem mais que alguns segundos pra
    // liberar o resto da pagina - vimos um caso que so tira o loader depois
    // de quase 20s. Com a espera fixa antiga, a gente capturava o HTML no
    // meio da intro: nem faltava recurso nem dava erro, so ficava com o
    // loader/gradiente de fundo e o conteudo real (texto, imagens) travado
    // em opacity:0 por uma classe tipo "loading" no <body> que a propria
    // pagina so remove depois que a intro termina. Detecta esse padrao
    // (classe de loading no html/body, ou um elemento #loader/.preloader
    // ainda visivel) e so segue em frente quando ele sumir - sites sem esse
    // padrao passam direto, sem custo extra.
    const preloaderDeadline = Date.now() + 40000;
    while (Date.now() < preloaderDeadline && !ctx.signal?.aborted) {
      const stillLoading = await targetFrame
        .evaluate(() => {
          const classes = `${document.body?.className || ""} ${document.documentElement?.className || ""}`;
          if (/\b(loading|preload|is-loading)\b/i.test(classes)) return true;
          const el = document.querySelector(
            '#loader, .loader, #preloader, .preloader, [class*="loader" i], [class*="preload" i]'
          );
          if (!el) return false;
          const cs = getComputedStyle(el);
          return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
        })
        .catch(() => false);
      if (!stillLoading) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (ctx.signal?.aborted) throw new CancelError();
    ctx.onProgress?.("carregando-pagina", 28, "Conteudo pronto, preparando captura");

    // Tentativa anterior aqui era rolar em varios passos pequenos (em vez
    // de um pulo unico) pra dar tempo de IntersectionObservers disparar em
    // secoes com carregamento preguicoso. Revertido: quebrou uma cena de
    // fundo animado (Unicorn Studio) que dependia do scroll acontecer de
    // um jeito especifico - e nem teria ajudado o caso que motivou a
    // mudanca, ja que aquele site teve o proprio Puppeteer pulado (o HTML
    // estatico dele ja tem texto suficiente pra `detectNeedsSpa` decidir
    // que nao precisa de navegador de verdade).
    await targetFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // O snippet oficial do Unicorn Studio (usado pelo fundo animado em
    // varios templates Aura) e um "instalador" que so roda a logica real
    // (UnicornStudio.init()) se `window.UnicornStudio` ainda nao existir -
    // e ele mesmo injeta seu <script src=".../unicornStudio.umd.js">, cujo
    // onload chama o init(). Como a gente captura o DOM DEPOIS desse
    // <script> ja ter sido injetado, o snapshot fica com essa tag "fantasma"
    // gravada no HTML - no proximo carregamento ela executa ANTES do
    // snippet inline (que continua no HTML do jeito que foi escrito),
    // entao quando o snippet roda `window.UnicornStudio` ja existe e ele
    // nunca chama init() de novo: a animacao nao quebra visualmente (nao
    // da erro), so nunca desenha nada no canvas. Removendo a tag fantasma
    // e o estado de "ja inicializado", o snippet original volta a se
    // auto-instalar como da primeira vez.
    await targetFrame
      .evaluate(() => {
        document.querySelectorAll("[data-us-initialized]").forEach((el) => {
          el.removeAttribute("data-us-initialized");
          el.removeAttribute("data-scene-id");
        });
        document.querySelectorAll('script[src*="unicornstudio" i]').forEach((el) => el.remove());
      })
      .catch(() => {});

    let html;
    try {
      html = await targetFrame.content();
    } catch (err) {
      // Fechar o browser (cancelamento) derruba qualquer chamada pendente
      // no frame - se foi isso, sinaliza cancelado em vez de deixar o erro
      // criptico do Puppeteer ("Session closed", etc.) subir como se fosse
      // uma falha de verdade.
      if (ctx.signal?.aborted) throw new CancelError();
      throw err;
    }

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

    await browser.close().catch(() => {});
    return { html, requestedUrls };
  }
  ctx.onProgress?.("carregando-pagina", 20, "Buscando HTML");
  let data;
  try {
    ({ data } = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      headers: { "User-Agent": UA },
      signal: ctx.signal,
    }));
  } catch (err) {
    if (axios.isCancel(err) || err.code === "ERR_CANCELED") throw new CancelError();
    throw err;
  }
  return { html: data, requestedUrls: [] };
}

// Windows recusa esses caracteres em nome de arquivo, e silenciosamente
// descarta ponto/espaco no final - um nome que vira so "..." depois do
// split de query/hash (ou qualquer outro que so sobre pontos/espacos)
// produz uma entrada de zip que o Explorer (e o .NET) rejeitam na hora de
// extrair, mesmo o zip sendo valido pra ferramentas mais tolerantes.
function sanitizeFileName(name) {
  let n = name.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[.\s]+$/, "");
  if (!n) n = "file";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n)) n = `_${n}`;
  return n;
}

// Tudo (JS, CSS, imagens) cai numa unica pasta assets/, igual a
// estrutura que a maioria das ferramentas de download de site usa
// (index.html + assets/). "folder" so serve mais pra decidir a
// extensao padrao quando o nome do arquivo original nao tem uma.
//
// urlCache: varios sites repetem a MESMA URL absoluta em lugares
// diferentes do HTML (ex: <img src="X" srcset="X 1x, Y 2x">, onde X
// aparece tanto no src quanto como primeiro candidato do srcset). Sem
// memoizar por URL, cada chamada gera um nome novo (X vira "_2" na
// primeira vez e "_3" na segunda, ja que "seen" so sabe quais NOMES
// DE ARQUIVO ja foram usados, nao quais URLs). O HTML fica com src e
// srcset apontando pra nomes DIFERENTES do mesmo arquivo - e como so um
// dos dois sobrevive (o crawlJsImports/crawlCssUrls dedupam por URL
// depois, descartando a outra copia "fantasma"), o outro fica
// permanentemente quebrado. Memoizando por URL, a segunda chamada pra
// mesma URL reaproveita o nome ja escolhido em vez de inventar outro.
function localName(resUrl, folder, seen, urlCache) {
  if (urlCache?.has(resUrl)) return urlCache.get(resUrl);
  let name = path.basename(new URL(resUrl).pathname) || "index";
  name = sanitizeFileName(name.split("?")[0].split("#")[0] || "file");
  if (!path.extname(name)) name += folder === "css" ? ".css" : folder === "js" ? ".js" : "";
  let final = `assets/${name}`;
  let i = 1;
  while (seen.has(final)) {
    const ext = path.extname(name);
    final = `assets/${path.basename(name, ext)}_${i++}${ext}`;
  }
  seen.add(final);
  urlCache?.set(resUrl, final);
  return final;
}

// Bundlers como Vite marcam chunks carregados sob demanda (React.lazy,
// import() dinamico) com o nome do arquivo escrito em texto dentro do
// bundle - mesmo que o navegador so peca esse arquivo quando alguem
// realmente clica em algo (o que nunca acontece no carregamento unico
// que o Puppeteer faz). Aqui a gente varre o texto de cada JS ja
// baixado atras desses imports e busca os arquivos direto, recursivamente,
// pra nao depender de "visitar" cada tela do site pra descobrir os chunks.
async function crawlJsImports(initialResults, seen, urlCache, signal) {
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

      const buf = await fetchBuffer(resolvedAbs, signal);
      known.set(resolvedAbs, { absUrl: resolvedAbs, local: null, buf });
      if (!buf) continue;

      const folder = resolvedAbs.endsWith(".css") ? "css" : "js";
      const local = localName(resolvedAbs, folder, seen, urlCache);
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
async function crawlCssUrls(results, seen, urlCache, signal) {
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

      const buf = await fetchBuffer(abs, signal);
      known.set(abs, { absUrl: abs, local: null, buf });
      if (!buf) continue;

      const local = localName(abs, "img", seen, urlCache);
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

async function detectNeedsSpa(target, signal) {
  try {
    const { data } = await axios.get(target, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { "User-Agent": UA },
      signal,
    });
    return looksLikeEmptyShell(data);
  } catch (err) {
    if (axios.isCancel(err) || err.code === "ERR_CANCELED") throw new CancelError();
    // se nem a busca simples funcionar, tenta o caminho mais robusto
    return true;
  }
}

// Faz todo o trabalho de baixar HTML + descobrir/buscar os assets (CSS,
// JS, imagens, video/audio) e devolve o DOM ja reescrito (referencias
// locais) junto com os buffers baixados. Usado pelo /download nos tres
// modos (site/design-system/both) - mesmo no modo "so design system" a
// extracao depende do CSS final, entao a coleta roda igual.
// Marcadores especificos das paginas que o Cloudflare mostra no lugar do
// site de verdade quando o visitante (no nosso caso, o Puppeteer/axios
// rodando de um IP de datacenter) e classificado como suspeito. Sem essa
// checagem, o zip sai "funcionando" mas cheio so dessa tela - o usuario
// so descobre abrindo o arquivo (e pior: pedacos de URL da pagina de
// bloqueio podem parecer jobs de imagem quebrados, mascarando a causa
// real). Duas variantes distintas, cada uma com seus proprios marcadores
// especificos pra nao dar falso positivo em site nenhum de verdade:
//   - desafio JS/Turnstile ("verificando seu navegador")
//   - pagina de bloqueio do WAF ("Attention Required!")
function isCloudflareChallenge(html) {
  const isJsChallenge = html.includes("cdn-cgi/challenge-platform") && html.includes("challenges.cloudflare.com");
  const isWafBlock = html.includes("cf-error-details") && /Attention Required/i.test(html);
  return isJsChallenge || isWafBlock;
}

async function buildSiteAssets(target, ctx = {}) {
  const base = new URL(target);
  ctx.onProgress?.("detectando", 5, "Verificando o site");
  const useSpa = await detectNeedsSpa(target, ctx.signal);
  const { html, requestedUrls } = await getHtml(target, useSpa, ctx);
  if (isCloudflareChallenge(html)) {
    throw new Error(
      "Este site esta protegido por verificacao anti-bot (Cloudflare) e bloqueou o acesso pra download. Nao ha como contornar isso de forma automatica."
    );
  }
  const $ = cheerio.load(html);
  const seen = new Set();
  // Memoiza local name por URL absoluta - ver comentario em localName().
  const urlToLocal = new Map();
  const jobs = [];
  const moduleEntries = [];
  const modulePreloadChunks = [];

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
      const local = localName(abs, "css", seen, urlToLocal);
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
        const local = localName(abs, "img", seen, urlToLocal);
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
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (!src) return;
      const abs = new URL(src, base).href;
      const local = localName(abs, "js", seen, urlToLocal);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
      dropCrossOrigin(el);
      if ($(el).attr("type") === "module") {
        moduleEntries.push({ el, local });
      }
    });

    // Modulepreload/preload de scripts (Vite/React e outros bundlers com
    // code-splitting expõem os chunks JS assim, não como <script src>)
    $('link[rel="modulepreload"], link[rel="preload"][as="script"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = new URL(href, base).href;
      const local = localName(abs, "js", seen, urlToLocal);
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
        const local = localName(abs, "img", seen, urlToLocal);
        jobs.push({ absUrl: abs, local });
        $(el).attr("src", local);
      }

      const srcset = $(el).attr("srcset");
      if (srcset) {
        // Vírgula seguida de espaço separa candidatos ("url 1x, url 2x") -
        // mas varios CDNs/plugins (resize=300,200 do WordPress, transforms
        // do Cloudflare Image Resizing etc.) usam virgula SEM espaço DENTRO
        // da propria URL (largura,altura). Um split ingenuo em toda virgula
        // corta essas URLs ao meio, e o pedaço depois da virgula (ex:
        // "200 300w") vira um "job" de imagem fantasma (resolve pra um URL
        // que nao existe, tipo dominio.com/200) - a imagem de verdade nunca
        // e baixada. So separa em virgula+espaco, que e como todo gerador
        // de srcset de verdade escreve os separadores.
        const rewritten = srcset
          .split(/,\s+/)
          .map((part) => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.search(/\s/);
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const descriptor = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
            if (!url || url.startsWith("data:")) return trimmed;
            const abs = new URL(url, base).href;
            const local = localName(abs, "img", seen, urlToLocal);
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
      const local = localName(abs, "img", seen, urlToLocal);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
    });
    $("video[poster]").each((_, el) => {
      const poster = $(el).attr("poster");
      if (!poster || poster.startsWith("data:")) return;
      const abs = new URL(poster, base).href;
      const local = localName(abs, "img", seen, urlToLocal);
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
        : IMAGE_EXT_RE.test(u.pathname)
        ? "img"
        : "js";
      const local = localName(u.href, folder, seen, urlToLocal);
      jobs.push({ absUrl: u.href, local });
      knownAbs.add(u.href);
    }

    // Baixa todos os recursos em paralelo. E a parte mais demorada e mais
    // variavel (de poucos arquivos a centenas) - reportar X/Y concluidos e
    // o que da o grosso da precisao real da barra de progresso.
    ctx.onProgress?.("baixando-assets", 30, `0/${jobs.length} arquivos`);
    let assetsDone = 0;
    let results = await Promise.all(
      jobs.map(async (j) => {
        const buf = await fetchBuffer(j.absUrl, ctx.signal);
        assetsDone++;
        ctx.onProgress?.(
          "baixando-assets",
          30 + Math.round((50 * assetsDone) / Math.max(1, jobs.length)),
          `${assetsDone}/${jobs.length} arquivos`
        );
        return { ...j, buf };
      })
    );

    // Quando o download de um recurso falha (CDN de terceiros bloqueando
    // por reputacao de IP tipo Cloudflare bot management - cdn.midjourney.com
    // e' um caso real visto em producao - ou qualquer outro erro de rede),
    // as tags acima ja foram reescritas pra apontar pro arquivo local ANTES
    // de saber se o fetch ia dar certo. Sem isso, a tag fica IRRECUPERAVELMENTE
    // quebrada (aponta pra um arquivo que nunca existiu no zip), mesmo que o
    // recurso original continue perfeitamente acessivel pra quem abrir o site
    // baixado depois (outro IP, outra hora). Reverte pro URL absoluto original
    // nesses casos - na pior das hipoteses o comportamento volta a ser "preciso
    // de internet pra essa imagem", que e' bem melhor que "quebrada pra sempre".
    const failedAbsByLocal = new Map(results.filter((r) => !r.buf).map((r) => [r.local, r.absUrl]));
    if (failedAbsByLocal.size > 0) {
      const revertLocalRefs = (value) => {
        let out = value;
        for (const [local, abs] of failedAbsByLocal) out = out.split(local).join(abs);
        return out;
      };
      $("[src]").each((_, el) => {
        const v = $(el).attr("src");
        if (v && failedAbsByLocal.has(v)) $(el).attr("src", failedAbsByLocal.get(v));
      });
      $("[srcset]").each((_, el) => {
        const v = $(el).attr("srcset");
        if (v) $(el).attr("srcset", revertLocalRefs(v));
      });
      $("[href]").each((_, el) => {
        const v = $(el).attr("href");
        if (v && failedAbsByLocal.has(v)) $(el).attr("href", failedAbsByLocal.get(v));
      });
      $("[poster]").each((_, el) => {
        const v = $(el).attr("poster");
        if (v && failedAbsByLocal.has(v)) $(el).attr("poster", failedAbsByLocal.get(v));
      });
      $("style").each((_, el) => {
        const text = $(el).html();
        if (text) $(el).html(revertLocalRefs(text));
      });
      $("[style]").each((_, el) => {
        const v = $(el).attr("style");
        if (v) $(el).attr("style", revertLocalRefs(v));
      });
    }

    // Busca tambem os chunks carregados sob demanda (nao aparecem no HTML,
    // so referenciados em texto dentro dos JS ja baixados). Isso vale
    // independente de ter usado Puppeteer ou nao - um site pode ja vir
    // com texto suficiente no HTML puro (Framer, por exemplo, pre-
    // renderiza pro SEO) e mesmo assim ter <script type="module"> que
    // precisa ser empacotado pra funcionar offline.
    ctx.onProgress?.("buscando-dependencias", 82, "Verificando dependencias de JS/CSS");
    try {
      results = await crawlJsImports(results, seen, urlToLocal, ctx.signal);
    } catch (err) {
      if (err instanceof CancelError) throw err;
      logError("crawlJsImports", err, { url: target });
    }

    // Mesma logica pra CSS: imagem de fundo, fonte @font-face etc.
    // referenciadas via url(...) dentro do arquivo .css baixado.
    try {
      results = await crawlCssUrls(results, seen, urlToLocal, ctx.signal);
    } catch (err) {
      if (err instanceof CancelError) throw err;
      logError("crawlCssUrls", err, { url: target });
    }

  return { $, base, results, moduleEntries, modulePreloadChunks };
}

// Tres opcoes de download, escolhidas via ?mode= depois que o cliente
// informa a URL:
//   - "site"          (padrao): so o site (index.html + assets/), igual ao
//                      comportamento historico do /download.
//   - "design-system": design-system.html (CSS/JS que estava inline vira
//                      arquivo proprio em assets/css|js, SVG classificado)
//                      + os mesmos assets do site (imagens/fontes/libs) +
//                      STACK.md. Sem index.html. O ganho e o HTML principal
//                      ficar bem menor (poucos KB em vez de um bundle
//                      inteiro inline) - nao o tamanho total do zip.
//   - "both":          zip com index.html (original) e design-system.html
//                      (organizado) lado a lado, compartilhando a mesma
//                      pasta assets/ (a extracao de CSS/JS so acrescenta
//                      assets/css|js novos, sem duplicar nada).
const DOWNLOAD_MODES = new Set(["site", "design-system", "both"]);

// Envia o zip pro cliente (zip.pipe(res)) e, ao MESMO TEMPO, coleta os
// mesmos bytes num buffer completo - sem isso, so daria pra escolher entre
// "streamar rapido pro usuario" OU "guardar o arquivo inteiro pro
// historico", nao os dois. pipe() do Node aceita varios destinos do mesmo
// readable, entao os dois acontecem em paralelo sem atrasar a resposta.
function pipeZipAndCapture(zip, res) {
  const chunks = [];
  const capture = new PassThrough();
  capture.on("data", (chunk) => chunks.push(chunk));
  const captured = new Promise((resolve, reject) => {
    capture.on("end", () => resolve(Buffer.concat(chunks)));
    capture.on("error", reject);
  });
  zip.pipe(res);
  zip.pipe(capture);
  return captured;
}

function isCancelLike(err) {
  return err instanceof CancelError || axios.isCancel(err) || err?.code === "ERR_CANCELED";
}

app.get("/download", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Falta o parametro ?url=");

  const mode = DOWNLOAD_MODES.has(req.query.mode) ? req.query.mode : "site";
  // Opcional: se o cliente mandar, ativa acompanhamento de progresso
  // (GET /download/progress/:requestId) e cancelamento
  // (POST /download/cancel/:requestId) pra esse download especifico. Sem
  // ele, o comportamento e identico ao de sempre (compatibilidade com
  // quem ainda chama /download sem essa param).
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId : null;
  const job = requestId ? createJob(requestId) : { signal: undefined, onProgress: () => {}, setBrowser: () => {} };
  const ctx = {
    signal: job.signal,
    onProgress: (stage, percent, message) => {
      job.stage = stage;
      job.percent = percent;
      job.message = message;
    },
    setBrowser: (browser) => {
      job.browser = browser;
    },
  };

  try {
    new URL(target);
  } catch {
    if (requestId) finishJob(requestId, "error");
    return res.status(400).send("URL invalida");
  }

  let historyStatus = "error";
  let historyBuffer = null;
  let historyFileName = null;
  let historyErrorMessage = null;

  try {
    const { $, base, results: collected, moduleEntries, modulePreloadChunks } = await buildSiteAssets(target, ctx);
    let results = collected;
    const hostname = base.hostname.replace(/[^a-z0-9.-]/gi, "_");

    // Precisa acontecer ANTES do empacotamento de modulos: buildDesignSystem
    // trabalha em cima de uma copia propria do DOM (nao mexe no $ usado pelo
    // modo "site"/"both" abaixo) e nao depende do resultado do bundle de JS.
    const designSystem =
      mode === "design-system" || mode === "both" ? buildDesignSystem($) : null;

    // Modo "so design system": nem baixa/empacota o JS (bundleModuleEntries),
    // ja devolve o zip so com o design-system.html + os mesmos assets do
    // site (imagens/fontes/libs continuam locais, so nao ha index.html).
    if (mode === "design-system") {
      historyFileName = `${hostname}-design-system.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${historyFileName}"`);
      const zip = archiver("zip", { zlib: { level: 9 } });
      zip.on("error", (err) => {
        logError("zip-stream", err, { url: target, mode });
        res.status(500).end(String(err));
      });
      const captured = pipeZipAndCapture(zip, res);
      zip.append(designSystem.html, { name: "design-system.html" });
      for (const f of designSystem.files) zip.append(f.buf, { name: f.name });
      for (const r of results) {
        if (r.buf) zip.append(r.buf, { name: r.local });
      }
      zip.append(designSystem.stackMd, { name: "STACK.md" });
      ctx.onProgress("compactando", 95, "Gerando arquivo zip");
      await zip.finalize();
      historyBuffer = await captured;
      historyStatus = "success";
      if (requestId) finishJob(requestId, "done");
      saveDownloadHistory({
        userEmail: req.userEmail,
        url: target,
        mode,
        status: historyStatus,
        buffer: historyBuffer,
        fileName: historyFileName,
      }).catch((err) => logError("download-history", err, { url: target, mode }));
      return;
    }

    // Empacota os scripts type="module" num script classico, pra dar pra
    // abrir o index.html direto com duplo-clique (navegadores bloqueiam
    // modulos ES quando a pagina vem de file://), sempre que existir
    // algum. Se o empacotamento falhar (ex: site importa algo de uma URL
    // externa que o esbuild nao consegue resolver), mantem a versao
    // original modular - o site continua baixavel, so precisa de um
    // servidor local pra abrir.
    if (moduleEntries.length > 0) {
      ctx.onProgress("empacotando", 90, "Empacotando modulos JS");
      try {
        results = await bundleModuleEntries({ $, moduleEntries, modulePreloadChunks, results });
      } catch (err) {
        logError("bundleModuleEntries", err, { url: target, mode });
      }
    }

    // Monta o ZIP ("site" ou "both")
    historyFileName = `${hostname}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${historyFileName}"`);

    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.on("error", (err) => {
      logError("zip-stream", err, { url: target, mode });
      res.status(500).end(String(err));
    });
    const captured = pipeZipAndCapture(zip, res);

    zip.append($.html(), { name: "index.html" });
    for (const r of results) {
      if (r.buf) zip.append(r.buf, { name: r.local });
    }
    if (mode === "both") {
      // Compartilha a mesma pasta assets/ do site - a extracao de CSS/JS
      // so acrescenta assets/css|js novos, entao nao ha nada pra duplicar.
      zip.append(designSystem.html, { name: "design-system.html" });
      for (const f of designSystem.files) zip.append(f.buf, { name: f.name });
      zip.append(designSystem.stackMd, { name: "STACK.md" });
    }
    ctx.onProgress("compactando", 95, "Gerando arquivo zip");
    await zip.finalize();
    historyBuffer = await captured;
    historyStatus = "success";
    if (requestId) finishJob(requestId, "done");
    saveDownloadHistory({
      userEmail: req.userEmail,
      url: target,
      mode,
      status: historyStatus,
      buffer: historyBuffer,
      fileName: historyFileName,
    }).catch((err) => logError("download-history", err, { url: target, mode }));
  } catch (err) {
    const canceled = isCancelLike(err);
    historyStatus = canceled ? "canceled" : "error";
    historyErrorMessage = err.message;
    if (requestId) finishJob(requestId, historyStatus);
    if (!canceled) logError("download", err, { url: target, mode });
    if (!res.headersSent) {
      res
        .status(canceled ? 499 : 500)
        .send(canceled ? "Download cancelado." : "Erro ao baixar: " + err.message);
    } else {
      res.end();
    }
    saveDownloadHistory({
      userEmail: req.userEmail,
      url: target,
      mode,
      status: historyStatus,
      errorMessage: historyErrorMessage,
    }).catch((e) => logError("download-history", e, { url: target, mode }));
  }
});

// Progresso do download identificado por requestId (poll simples em vez de
// SSE - mais robusto atras do proxy Traefik/Dokploy, e uma barra de
// progresso nao precisa de atualizacao sub-segundo).
app.get("/download/progress/:requestId", (req, res) => {
  const job = getJob(req.params.requestId);
  if (!job) return res.status(404).json({ error: "Job nao encontrado (ja concluido ou nunca existiu)." });
  res.json({ stage: job.stage, percent: job.percent, message: job.message, status: job.status });
});

app.post("/download/cancel/:requestId", (req, res) => {
  const ok = cancelJob(req.params.requestId);
  if (!ok) return res.status(404).json({ error: "Job nao encontrado (ja concluido ou nunca existiu)." });
  res.json({ ok: true });
});

app.get("/downloads/history", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const items = await listDownloadHistory({ userEmail: req.userEmail, limit, offset });
    res.json({ items, limit, offset });
  } catch (err) {
    logError("list-download-history", err, { userEmail: req.userEmail });
    res.status(500).json({ error: "Erro ao buscar historico." });
  }
});

app.get("/downloads/history/:id/file", async (req, res) => {
  try {
    const result = await getDownloadHistorySignedUrl({ userEmail: req.userEmail, id: req.params.id });
    if (!result) return res.status(404).json({ error: "Registro nao encontrado." });
    res.json(result);
  } catch (err) {
    logError("get-download-history-file", err, { userEmail: req.userEmail, id: req.params.id });
    res.status(500).json({ error: "Erro ao gerar link de download." });
  }
});

app.delete("/downloads/history/:id", async (req, res) => {
  try {
    const ok = await deleteDownloadHistoryEntry({ userEmail: req.userEmail, id: req.params.id });
    if (!ok) return res.status(404).json({ error: "Registro nao encontrado." });
    res.json({ ok: true });
  } catch (err) {
    logError("delete-download-history", err, { userEmail: req.userEmail, id: req.params.id });
    res.status(500).json({ error: "Erro ao apagar registro." });
  }
});

// Multipart em memoria (nunca grava em disco - o buffer sobe direto pro
// Storage) so' na rota de report, com limite de tamanho e so aceitando
// imagem no campo de print.
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Só imagens são aceitas no print."));
    cb(null, true);
  },
});
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitos reports em pouco tempo - tente novamente mais tarde." },
});

app.post("/report-error", reportLimiter, (req, res, next) => {
  reportUpload.single("screenshot")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { url, description } = req.body;
  if (!url || !description) {
    return res.status(400).json({ error: "url e description sao obrigatorios." });
  }
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "URL invalida." });
  }

  try {
    const id = await saveErrorReport({
      userEmail: req.userEmail,
      url,
      description,
      screenshotBuffer: req.file?.buffer ?? null,
      screenshotMime: req.file?.mimetype ?? null,
    });
    res.json({ ok: true, id });
  } catch (err) {
    logError("report-error", err, { url });
    res.status(500).json({ error: "Erro ao salvar o report." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Site Downloader rodando em http://localhost:${PORT}`)
);
