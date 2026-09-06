// Extrai um resumo de "design tokens" (cores, tipografia, espacamento,
// raios, sombras) a partir do CSS e HTML ja baixados de um site pelo
// /download. Alimenta o modo de download personalizado: o consumidor da
// API pode mostrar esses tokens antes de decidir o que aproveitar, sem
// precisar abrir o CSS/HTML na mao.
//
// Abordagem por regex sobre o texto das declaracoes (mesmo estilo do
// CSS_URL_RE em server.js), nao um parser CSS de verdade - suficiente pra
// minerar valores, e evita adicionar uma dependencia so pra isso. Como o
// arquivo CSS baixado ja e o CSS *compilado* do site (inclusive de builds
// Tailwind), classes utilitarias tipo bg-white ja aparecem aqui como
// declaracoes de verdade (".bg-white{background-color:#fff}") - nao
// precisamos conhecer a paleta padrao do Tailwind pra cobrir esses casos.

const HEX_RE = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?)\(\s*[^)]+\)/g;
const HEX_FULL_RE = /^#(?:[0-9a-fA-F]{3,4}){1,2}$/;
const FUNC_COLOR_FULL_RE = /^(?:rgba?|hsla?)\(\s*[^)]+\)$/;

const SKIP_VALUES = new Set([
  "transparent",
  "inherit",
  "initial",
  "unset",
  "none",
  "currentcolor",
]);

// prop -> balde de cor onde os tokens encontrados no valor devem cair
const COLOR_PROP_BUCKET = {
  color: "text",
  "-webkit-text-fill-color": "text",
  background: "background",
  "background-color": "background",
  border: "border",
  "border-color": "border",
  "border-top-color": "border",
  "border-right-color": "border",
  "border-bottom-color": "border",
  "border-left-color": "border",
  outline: "border",
  "outline-color": "border",
  fill: "fill",
  stroke: "fill",
  "box-shadow": "shadow",
  "text-shadow": "shadow",
};

const SPACING_PROPS = new Set([
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "row-gap",
  "column-gap",
]);

const SPACING_VALUE_RE = /^-?\d*\.?\d+(?:px|rem|em|%)$/;

// Classes utilitarias com valor arbitrario entre colchetes (Tailwind e
// afins), pra casos onde o CSS final nao vem compilado estaticamente
// (ex: Tailwind via CDN em runtime, sem build). prefix -> categoria.
const ARBITRARY_CLASS_RE =
  /\b(bg|from|via|to|text|border|ring|divide|outline|shadow|rounded(?:-(?:t|r|b|l|tl|tr|bl|br))?|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-\[([^\]\s]+)\]/g;

const ARBITRARY_COLOR_PREFIXES = new Set(["bg", "from", "via", "to", "border", "ring", "divide", "outline"]);
const ARBITRARY_RADIUS_PREFIXES = new Set([
  "rounded",
  "rounded-t",
  "rounded-r",
  "rounded-b",
  "rounded-l",
  "rounded-tl",
  "rounded-tr",
  "rounded-bl",
  "rounded-br",
]);
const ARBITRARY_SPACING_PREFIXES = new Set([
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap", "gap-x", "gap-y",
]);

function looksLikeColor(value) {
  return HEX_FULL_RE.test(value) || FUNC_COLOR_FULL_RE.test(value);
}

function normalizeColor(raw) {
  let v = raw.trim().replace(/\s+/g, " ");
  if (/^#[0-9a-fA-F]{3,4}$/.test(v)) {
    v = "#" + v.slice(1).split("").map((c) => c + c).join("");
  }
  return v.toLowerCase();
}

function extractColorTokens(value) {
  const found = [];
  for (const m of value.matchAll(HEX_RE)) found.push(normalizeColor(m[0]));
  for (const m of value.matchAll(FUNC_COLOR_RE)) found.push(normalizeColor(m[0]));
  return found;
}

class Counter {
  constructor() {
    this.map = new Map();
  }
  add(value, n = 1) {
    if (!value) return;
    this.map.set(value, (this.map.get(value) || 0) + n);
  }
  top(limit) {
    return Array.from(this.map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
  }
}

function collectCssText($, results) {
  const chunks = [];
  for (const r of results) {
    if (r.buf && r.local && r.local.endsWith(".css")) {
      chunks.push(r.buf.toString("utf8"));
    }
  }
  $("style").each((_, el) => {
    const text = $(el).html();
    if (text) chunks.push(text);
  });
  const inlineDecls = [];
  $("[style]").each((_, el) => {
    const styleAttr = $(el).attr("style");
    if (styleAttr) inlineDecls.push(styleAttr.trim().replace(/;?$/, ";"));
  });
  if (inlineDecls.length > 0) chunks.push(inlineDecls.join(" "));
  return chunks.join("\n");
}

function collectClassAttrs($) {
  const classes = [];
  $("[class]").each((_, el) => {
    const cls = $(el).attr("class");
    if (cls) classes.push(cls);
  });
  return classes.join(" ");
}

// Regex generico de declaracao "prop: valor" - nao e um parser CSS de
// verdade (nao entende seletores/aninhamento), so mineracao de valores.
// Terminador aceita ";" OU "}" pra cobrir o ultimo decl de um bloco
// minificado, sem "}" contar como parte do valor.
const DECL_RE = /([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g;

function scanDeclarations(cssText, buckets) {
  for (const m of cssText.matchAll(DECL_RE)) {
    const prop = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (!value || SKIP_VALUES.has(value.toLowerCase())) continue;

    if (prop.startsWith("--")) {
      if (looksLikeColor(value)) {
        buckets.variables.add(`${prop}: ${normalizeColor(value)}`);
      }
      continue;
    }

    const colorBucket = COLOR_PROP_BUCKET[prop];
    if (colorBucket) {
      for (const token of extractColorTokens(value)) {
        buckets[colorBucket].add(token);
        buckets.allColors.add(token);
      }
    }

    if (prop === "box-shadow" || prop === "text-shadow") {
      buckets.shadows.add(value.replace(/\s+/g, " "));
    }

    if (prop === "font-family") {
      const primary = value.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (primary) buckets.fontFamilies.add(primary);
    }

    if (prop === "font-size" && SPACING_VALUE_RE.test(value)) {
      buckets.fontSizes.add(value);
    }

    if (prop === "font-weight" && /^(?:\d{3}|normal|bold|lighter|bolder)$/.test(value)) {
      buckets.fontWeights.add(value);
    }

    if (prop === "line-height" && /^-?\d*\.?\d+(?:px|rem|em|%)?$/.test(value)) {
      buckets.lineHeights.add(value);
    }

    if (prop === "border-radius" || (prop.startsWith("border-") && prop.endsWith("-radius"))) {
      buckets.radii.add(value.replace(/\s+/g, " "));
    }

    if (SPACING_PROPS.has(prop)) {
      for (const part of value.split(/\s+/)) {
        if (SPACING_VALUE_RE.test(part) && part !== "0") buckets.spacing.add(part);
      }
    }
  }
}

function scanArbitraryClasses(classText, buckets) {
  for (const m of classText.matchAll(ARBITRARY_CLASS_RE)) {
    const prefix = m[1];
    const raw = decodeURIComponent(m[2].replace(/\\_/g, " ").replace(/_/g, " "));

    if (ARBITRARY_COLOR_PREFIXES.has(prefix) && looksLikeColor(raw)) {
      const token = normalizeColor(raw);
      buckets.allColors.add(token);
      if (prefix === "bg" || prefix === "from" || prefix === "via" || prefix === "to") {
        buckets.background.add(token);
      } else {
        buckets.border.add(token);
      }
      continue;
    }
    if (prefix === "text") {
      if (looksLikeColor(raw)) {
        const token = normalizeColor(raw);
        buckets.text.add(token);
        buckets.allColors.add(token);
      } else if (SPACING_VALUE_RE.test(raw)) {
        buckets.fontSizes.add(raw);
      }
      continue;
    }
    if (prefix === "shadow") {
      buckets.shadows.add(raw.replace(/\s+/g, " "));
      continue;
    }
    if (ARBITRARY_RADIUS_PREFIXES.has(prefix)) {
      buckets.radii.add(raw);
      continue;
    }
    if (ARBITRARY_SPACING_PREFIXES.has(prefix) && SPACING_VALUE_RE.test(raw) && raw !== "0") {
      buckets.spacing.add(raw);
    }
  }
}

/**
 * @param {{ $: import("cheerio").CheerioAPI, results: Array<{local:string, buf:Buffer|null}>, source?: string }} opts
 */
export function extractDesignSystem({ $, results, source }) {
  const buckets = {
    variables: new Counter(),
    background: new Counter(),
    text: new Counter(),
    border: new Counter(),
    fill: new Counter(),
    shadow: new Counter(),
    allColors: new Counter(),
    fontFamilies: new Counter(),
    fontSizes: new Counter(),
    fontWeights: new Counter(),
    lineHeights: new Counter(),
    radii: new Counter(),
    spacing: new Counter(),
    shadows: new Counter(),
  };

  const cssText = collectCssText($, results);
  scanDeclarations(cssText, buckets);
  scanArbitraryClasses(collectClassAttrs($), buckets);

  return {
    source: source || null,
    generatedAt: new Date().toISOString(),
    colors: {
      variables: buckets.variables.top(40),
      background: buckets.background.top(20),
      text: buckets.text.top(20),
      border: buckets.border.top(20),
      fill: buckets.fill.top(20),
      shadow: buckets.shadow.top(20),
      all: buckets.allColors.top(30),
    },
    typography: {
      fontFamilies: buckets.fontFamilies.top(10),
      fontSizes: buckets.fontSizes.top(15),
      fontWeights: buckets.fontWeights.top(8),
      lineHeights: buckets.lineHeights.top(10),
    },
    spacing: buckets.spacing.top(20),
    radii: buckets.radii.top(12),
    shadows: buckets.shadows.top(12),
  };
}
