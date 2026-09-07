import * as cheerio from "cheerio";

// Constroi um "design system" 100% deterministico (sem chamada de IA): o
// ganho de verdade e reduzir o TAMANHO/CONTAGEM DE TOKENS do HTML principal,
// nao o tamanho total baixado - por isso CSS/JS que estava inline (que e
// exatamente o que infla o HTML: um bundle inline de 700KB vira 700KB de
// texto dentro do <script>) sai pra arquivo proprio em assets/css|js, com um
// comentario descrevendo o que cada um faz. O restante dos assets (imagens,
// fontes, bibliotecas externas) continua local, igual ao /download normal -
// design-system.html so referencia os mesmos arquivos que index.html usa.
//
// Alem disso, SVG e classificado (icone Lucide / cor herdada via
// currentColor ou manipulado por JS / cor fixa) e cada secao de topo ganha
// um comentario com seu id. A estrutura original do HTML e preservada (nao
// e uma reescrita do zero) - isso garante fidelidade visual por construcao.

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
const HEX_TOKEN_RE = /^[0-9a-f]{3,8}$/i;
// Marca de classe utilitaria com valor arbitrario (bg-\[\#fff\], w-\[40px\]
// etc.) - a assinatura mais confiavel de que um bloco e Tailwind compilado.
const TAILWIND_ARBITRARY_RE = /\.(?:bg|text|border|w|h|p|m|gap|rounded|shadow|flex|grid)-?\\?\[/;

// Retira todo <style> inline, agrupa cada bloco num arquivo CSS proprio
// nomeado pela palavra mais frequente entre os seletores que ele define.
// So olha pra parte de SELETOR de cada regra (nunca o corpo/valores) -
// senao uma cor tipo "color:#fff" vira palavra-chave por engano.
function extractStyles($) {
  const files = [];
  const used = new Set();
  $("style").each((_, el) => {
    const text = $(el).html() || "";
    if (!text.trim()) {
      $(el).remove();
      return;
    }

    const selectorText = text.split(/\{[^{}]*\}/g).join(" "); // remove o corpo de cada regra (nao-aninhada)

    let name;
    const arbitraryHits = [...text.matchAll(new RegExp(TAILWIND_ARBITRARY_RE, "g"))].length;
    if (arbitraryHits > 5) {
      name = "tailwind-utilities";
      let i2 = 2;
      while (used.has(name)) name = `tailwind-utilities-${i2++}`;
      used.add(name);
    } else {
      const words = [];
      for (const m of selectorText.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
        if (HEX_TOKEN_RE.test(m[1])) continue;
        words.push(...splitWords(m[1]));
      }
      name = pickName(words, used, "estilos");
    }

    files.push({ name: `assets/css/${name}.css`, content: text, inHead: $(el).parents("head").length > 0 });
    $(el).remove();
  });
  return files;
}

// Retira todo <script> inline com codigo de verdade (ignora ld+json e
// scripts triviais de uma linha), agrupa por arquivo JS nomeado pelos
// identificadores (ids/seletores/nomes de funcao) mais frequentes nele.
function extractScripts($) {
  const files = [];
  const used = new Set();
  $("script").each((_, el) => {
    const $el = $(el);
    if ($el.attr("src")) return;
    if ($el.attr("type") === "application/ld+json") return;
    const text = $el.html() || "";
    const trimmed = text.trim();
    if (!trimmed) {
      $el.remove();
      return;
    }
    const isSingleLineHandler = !trimmed.includes("\n") && trimmed.length < 120;
    if (isSingleLineHandler) return;

    const words = [];
    for (const m of trimmed.matchAll(/(?:getElementById|querySelector(?:All)?)\(\s*["'`][.#]?([\w-]+)/g)) {
      words.push(...splitWords(m[1]));
    }
    for (const m of trimmed.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)/g)) words.push(...splitWords(m[1]));
    for (const m of trimmed.matchAll(/\bconst\s+([a-zA-Z_$][\w$]*)\s*=/g)) words.push(...splitWords(m[1]));
    const name = pickName(words, used, "interactions");
    files.push({ name: `assets/js/${name}.js`, content: trimmed, inHead: $el.parents("head").length > 0 });
    $el.remove();
  });
  return files;
}

const CURRENT_COLOR_RE = /currentColor/i;
const HARDCODED_COLOR_RE = /(?:fill|stroke)\s*=\s*["'](#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))["']/i;

// Um SVG cujo id (ou de algum filho seu, ex: um <path> animado) e
// referenciado em algum script extraido (getElementById/querySelector,
// scroll-linked etc.) precisa continuar no DOM pra esse JS continuar
// achando e manipulando ele - virar <img> congela a animacao (e como o
// arquivo extraido normalmente nao tem xmlns, muitos navegadores nem
// chegam a renderizar, disparando o proprio fallback de imagem quebrada
// do site no lugar).
function isReferencedByScript($, el, scriptText) {
  if (!scriptText) return false;
  const ids = [$(el).attr("id"), ...$(el).find("[id]").map((_, e) => $(e).attr("id")).get()].filter(Boolean);
  return ids.some((id) => scriptText.includes(id));
}

// Classifica cada <svg>: icone Lucide vira <i data-lucide>, SVG com
// currentColor OU manipulado por JS (por id) fica inline (so minificado),
// SVG com cor fixa e sem nenhum id referenciado em script e salvo como
// imagem e vira <img>. Na duvida entre B/C, escolhe B (mantem inline) - e a
// opcao segura, ja que virar <img> quebraria heranca de cor ou animacao.
function classifySvgs($, scriptText) {
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
    const drivenByJs = isReferencedByScript($, el, scriptText);

    if (hasHardcoded && !hasCurrentColor && !drivenByJs) {
      const idSeed = $el.attr("id") || $el.parent().attr("id") || $el.parent().attr("class") || "";
      const words = splitWords(idSeed);
      const name = pickName(words, used, "icon");
      const svgFileName = `assets/images/svg/${name}.svg`;
      // <img src="x.svg"> exige que o SVG seja um documento standalone
      // valido - sem xmlns declarado (dispensavel quando o SVG vive
      // inline no HTML) varios navegadores simplesmente recusam renderizar.
      const standalone = /\bxmlns\s*=/.test(outer)
        ? outer
        : outer.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      files.push({ name: svgFileName, buf: Buffer.from(standalone, "utf8") });
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

// Assinaturas conhecidas -> uma linha de STACK.md. Deteccao por padrao
// (nome/URL de arquivo, texto de biblioteca, atributo) - nao descreve o
// "porque" com a mesma riqueza que uma leitura humana faria, so lista o
// que achou.
function detectStack($, cssFiles, jsFiles) {
  const allJs = jsFiles.map((f) => f.content).join("\n");
  const allCss = cssFiles.map((f) => f.content).join("\n");
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
  if (/WebGLRenderingContext|getContext\(\s*["']webgl2?["']/.test(allJs)) {
    lines.push("- **WebGL** — API grafica acelerada por hardware usada para efeitos/shaders customizados.");
  }
  if ($("canvas").length > 0) {
    lines.push("- **HTML5 Canvas** — elemento(s) `<canvas>` usados para desenho/animacao 2D ou 3D customizados.");
  }
  if ($("video").length > 0) {
    lines.push("- **HTML5 Video** — elemento(s) `<video>` usados para midia embutida.");
  }
  if (/IntersectionObserver/.test(allJs)) {
    lines.push("- **IntersectionObserver** — usado para animacoes de revelacao ao rolar a pagina (scroll-reveal).");
  }
  if (/PointerEvent|pointerdown|pointermove|pointerup/.test(allJs)) {
    lines.push("- **Pointer Events API** — usada para interacoes de toque/arraste (sliders, drag).");
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
 *   o $ recebido nunca e mutado. Os demais assets (imagens, fontes,
 *   bibliotecas de terceiros) continuam locais e devem ser incluidos no zip
 *   pelo chamador (mesma lista `results` do /download) - so o CSS/JS que
 *   estava inline sai daqui como arquivo novo.
 */
export function buildDesignSystem($) {
  const d$ = cheerio.load($.html());

  const cssFiles = extractStyles(d$);
  const jsFiles = extractScripts(d$);
  const inlineScriptText = jsFiles.map((f) => f.content).join("\n");
  const svgFiles = classifySvgs(d$, inlineScriptText);
  annotateSections(d$);

  const head = d$("head");
  for (const f of cssFiles) {
    head.append(`<!-- css -->\n<link rel="stylesheet" href="${f.name}"/>\n`);
  }
  for (const f of jsFiles) {
    const tag = `<!-- js -->\n<script src="${f.name}"></script>\n`;
    if (f.inHead) head.append(tag);
    else d$("body").append(tag);
  }

  const stackMd = detectStack(d$, cssFiles, jsFiles);
  const files = [
    ...cssFiles.map((f) => ({ name: f.name, buf: Buffer.from(f.content, "utf8") })),
    ...jsFiles.map((f) => ({ name: f.name, buf: Buffer.from(f.content, "utf8") })),
    ...svgFiles,
  ];

  return { html: d$.html(), files, stackMd };
}
