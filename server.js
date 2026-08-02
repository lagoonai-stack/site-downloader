import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { fileURLToPath } from "url";
import path from "path";

import authRoutes from "./authRoutes.js";
import kiwifyWebhook from "./kiwifyWebhook.js";
import { requireActiveSubscriber } from "./requireActiveSubscriber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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

    // CSS
    $('link[rel="stylesheet"], link[as="style"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = new URL(href, base).href;
      const local = localName(abs, "css", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("href", local);
    });

    // JS
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (!src) return;
      const abs = new URL(src, base).href;
      const local = localName(abs, "js", seen);
      jobs.push({ absUrl: abs, local });
      $(el).attr("src", local);
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
    const results = await Promise.all(
      jobs.map(async (j) => ({ ...j, buf: await fetchBuffer(j.absUrl) }))
    );

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
