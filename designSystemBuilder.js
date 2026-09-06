import * as cheerio from "cheerio";

// Constroi um export de "design system" leve e 100% deterministico (sem
// chamada de IA) - diferente do /download normal, que baixa o site inteiro
// com todas as dependencias. Aqui:
//   - CSS/JS que ja estava inline continua inline no proprio HTML (nao vira
//     arquivo separado) - inclui as animacoes/interacoes do site.
//   - SVG e classificado (icone Lucide / cor herdada via currentColor / cor
//     fixa) igual antes.
//   - Qualquer referencia a arquivo que NAO seja imagem (fonte, biblioteca
//     JS como Three.js, runtime do Tailwind, CSS externo tipo Google Fonts)
//     volta a apontar pra URL remota original em vez do caminho local -
//     continua funcional com internet, mas nao infla o zip.
//   - So imagem realmente utilizada vira arquivo dentro do zip.
//
// A estrutura original do HTML e preservada (nao e uma reescrita do zero) -
// isso garante fidelidade visual por construcao.

const STOPWORDS = new Set([
  "container", "wrapper", "wrap", "item", "items", "block", "inline", "flex",
  "grid", "hidden", "visible", "active", "group", "relative", "absolute",
  "fixed", "sticky", "full", "btn", "icon", "text", "bg", "border", "hover",
  "focus", "dark", "light", "sm", "md", "lg", "xl", "top", "bottom", "left",
  "right", "center", "content", "section", "div", "span", "row", "col",
  "gap", "px", "py", "pt", "pb", "pl", "pr", "mx", "my", "mt", "mb", "ml",
  "mr", "z", "w", "h", "transition", "duration", "ease", "transform",
  "opacity", "shadow", "rounded", "overflow", "cursor", "pointer",
]);

function splitWords(raw) {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function pickName(words, used, fallbackPrefix) {
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const base = sorted.length > 0 ? sorted[0][0] : `${fallbackPrefix}-${used.size + 1}`;
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1?\s*\)/g;

const CURRENT_COLOR_RE = /currentColor/i;
const HARDCODED_COLOR_RE = /(?:fill|stroke)\s*=\s*["'](#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))["']/i;

// Classifica cada <svg>: icone Lucide vira <i data-lucide>, SVG com
// currentColor fica inline (so minificado), SVG com cor fixa e salvo como
// imagem e vira <img>. Na duvida entre B/C, escolhe B (mantem inline) - e a
// opcao segura, ja que virar <img> quebraria heranca de cor.
function classifySvgs($) {
  const files = [];
  const used = new Set();

  $("svg").each((_, el) => {
    const $el = $(el);
    if ($el.parents("svg").length > 0) return; // so o <svg> raiz, nao os aninhados (ex: <use>, <symbol>)
    const cls = $el.attr("class") || "";
    const dataLucide = $el.attr("data-lucide");
    const lucideMatch = cls.match(/\blucide-([\w-]+)/);

    if (dataLucide || lucideMatch) {
      const iconName = dataLucide || lucideMatch[1];
      const keptClasses = cls
        .split(/\s+/)
        .filter((c) => c && c !== "lucide" && !c.startsWith("lucide-"))
        .join(" ");
      $el.replaceWith(`<i data-lucide="${iconName}"${keptClasses ? ` class="${keptClasses}"` : ""}></i>`);
      return;
    }

    const outer = $.html(el);
    const hasHardcoded = HARDCODED_COLOR_RE.test(outer);
    const hasCurrentColor = CURRENT_COLOR_RE.test(outer);

    if (hasHardcoded && !hasCurrentColor) {
      const idSeed = $el.attr("id") || $el.parent().attr("id") || $el.parent().attr("class") || "";
      const words = splitWords(idSeed);
      const name = pickName(words, used, "icon");
      const svgFileName = `assets/images/svg/${name}.svg`;
      files.push({ name: svgFileName, buf: Buffer.from(outer, "utf8") });
      const classAttr = cls ? ` class="${cls}"` : "";
      $el.replaceWith(`<img src="${svgFileName}"${classAttr} alt="${name}"/>`);
    } else {
      // Categoria B: mantem inline, minificado numa linha so.
      const minified = outer.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
      $el.replaceWith(minified);
    }
  });

  return files;
}

// Insere um comentario antes de cada secao de topo do <body>, usando o id
// ou a classe que ela ja tiver (nao inventa nome novo).
function annotateSections($) {
  $("body")
    .children("section, header, footer, nav")
    .each((_, el) => {
      const $el = $(el);
      const label = $el.attr("id") || ($el.attr("class") || "").split(/\s+/)[0] || el.tagName.toLowerCase();
      $el.before(`<!-- ${label} -->\n`);
    });
}

// O download normal ja localizou todo href/src pra "assets/..." (ver
// buildSiteAssets em server.js). Aqui desfazemos isso seletivamente: so
// imagem continua local (vira arquivo no zip); fonte, biblioteca JS externa
// e CSS externo (Google Fonts etc.) voltam a apontar pro endereco remoto
// original, entao a pagina continua funcional (com internet) sem precisar
// empacotar esses arquivos, que sao o peso de verdade do download completo.
function revertNonImageRefsToOrigin($, localToAbs) {
  const backToRemote = (val) => {
    if (!val || /^(https?:)?\/\//.test(val) || val.startsWith("data:")) return null;
    if (IMAGE_EXT_RE.test(val)) return null;
    return localToAbs.get(val) || null;
  };

  $("link[href], script[src]").each((_, el) => {
    const attr = el.tagName.toLowerCase() === "link" ? "href" : "src";
    const val = $(el).attr(attr);
    const abs = backToRemote(val);
    if (abs) $(el).attr(attr, abs);
  });

  $("video[src], audio[src], video source[src], audio source[src]").each((_, el) => {
    const val = $(el).attr("src");
    const abs = backToRemote(val);
    if (abs) $(el).attr("src", abs);
  });

  $("style").each((_, el) => {
    const text = $(el).html() || "";
    if (!text.includes("url(")) return;
    const rewritten = text.replace(CSS_URL_RE, (full, _quote, raw) => {
      const trimmed = raw.trim();
      const abs = backToRemote(trimmed);
      return abs ? `url(${abs})` : full;
    });
    $(el).html(rewritten);
  });
}

// Assinaturas conhecidas -> uma linha de STACK.md. Deteccao por padrao
// (nome/URL de arquivo, texto de biblioteca, atributo) - nao descreve o
// "porque" com a mesma riqueza que uma leitura humana faria, so lista o
// que achou.
function detectStack($) {
  const allJs = $("script:not([src])")
    .toArray()
    .map((el) => $(el).html() || "")
    .join("\n");
  const allCss = $("style")
    .toArray()
    .map((el) => $(el).html() || "")
    .join("\n");
  const html = $.html();
  const lines = [];

  const hasTailwindCdn = $('script[src*="tailwindcss.com"]').length > 0 || /cdn\.tailwindcss\.com/.test(html);
  const hasTailwindUtilities = /\bclass="[^"]*\b(?:flex|grid|bg-\[|text-\[)/i.test(html);
  if (hasTailwindCdn || hasTailwindUtilities) {
    lines.push("- **Tailwind CSS** — framework CSS utility-first usado nas classes de layout/estilo inline pelo HTML.");
  }
  if ($('link[href*="fonts.googleapis.com"], link[href*="css2"]').length > 0) {
    lines.push("- **Google Fonts** — fontes web carregadas via folha de estilo externa (`css2`).");
  }
  if (/\bLucide\b/i.test(html) || $("[data-lucide]").length > 0 || $('script[src*="lucide"]').length > 0) {
    lines.push("- **Lucide** — biblioteca de icones usada via `<i data-lucide>`, renderizados em runtime pelo script da lib.");
  }
  if ($('script[src*="three"]').length > 0 || /\bTHREE\./.test(allJs)) {
    lines.push("- **Three.js** — biblioteca WebGL 3D usada para efeitos visuais animados.");
  }
  if ($("canvas").length > 0) {
    lines.push("- **HTML5 Canvas** — elemento(s) `<canvas>` usados para desenho/animacao 2D ou 3D customizados.");
  }
  if (/IntersectionObserver/.test(allJs)) {
    lines.push("- **IntersectionObserver** — usado para animacoes de revelacao ao rolar a pagina (scroll-reveal).");
  }
  if (/--[\w-]+\s*:/.test(allCss)) {
    lines.push("- **CSS custom properties (variaveis)** — sistema de tokens de cor/tipografia definido via variaveis CSS.");
  }
  if (/backdrop-filter|mix-blend-mode|mask-image/i.test(allCss) || /backdrop-blur|mix-blend|mask-/i.test(html)) {
    lines.push("- **Efeitos CSS avancados** — `backdrop-filter`/`mix-blend-mode`/`mask-image` usados para vidro fosco, glow e overlays.");
  }
  const hasFramework = /\breact\b/i.test(allJs) || /\bvue\b/i.test(allJs) || $("[ng-version]").length > 0;
  if (!hasFramework) {
    lines.push("- **JavaScript puro (Vanilla JS)** — interacoes escritas sem framework de front-end.");
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "- Nenhuma tecnologia identificada por assinatura conhecida.\n";
}

/**
 * @param {import("cheerio").CheerioAPI} $ - HTML ja com os assets (imagens/
 *   fontes/scripts externos) resolvidos para caminhos locais (ver
 *   buildSiteAssets em server.js). Uma copia propria e feita internamente -
 *   o $ recebido nunca e mutado.
 * @param {Array<{absUrl: string, local: string}>} results - mesma lista
 *   usada pelo /download, pra saber a URL remota original de cada caminho
 *   local (necessario pra "devolver" fontes/scripts/CSS externos ao
 *   endereco de origem em vez de empacotar).
 */
export function buildDesignSystem($, results) {
  const d$ = cheerio.load($.html());
  const localToAbs = new Map(results.map((r) => [r.local, r.absUrl]));

  const svgFiles = classifySvgs(d$);
  annotateSections(d$);
  revertNonImageRefsToOrigin(d$, localToAbs);

  const stackMd = detectStack(d$);
  return { html: d$.html(), files: svgFiles, stackMd };
}
