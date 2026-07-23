require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

/* ---------------------------------------------------------------------------
 * Configuração por plataforma
 * ------------------------------------------------------------------------- */
const PLATFORMS = {
  netflix: {
    senders: ['info@account.netflix.com', 'netflix@mailer.netflix.com', 'no-reply@netflix.com', 'help@netflix.com'],
    codeLengths: [4, 8], // Netflix: PIN/acesso (4) ou ativação (8)
    trustedDomains: ['netflix.com'],
  },
  disney: {
    senders: ['disneyplus@mail.disneyplus.com', 'no-reply@disneyplus.com', 'disneyplus@emails.disneyplus.com', 'noreply@disneyplus.com'],
    codeLengths: [6],
    trustedDomains: ['disneyplus.com', 'disney.com', 'go.com'],
  },
  max: {
    senders: ['no-reply@max.com', 'hbomax@mail.hbomax.com', 'max@email.max.com'],
    codeLengths: [6],
    trustedDomains: ['max.com', 'hbomax.com'],
  },
  primevideo: {
    senders: ['account-update@amazon.com', 'no-reply@amazon.com', 'auto-confirm@amazon.com', 'primevideo@amazon.com'],
    codeLengths: [6],
    trustedDomains: ['amazon.com', 'amazon.com.br', 'primevideo.com'],
  },
};

const VALID_PLATFORMS = Object.keys(PLATFORMS);
const SEARCH_WINDOW_HOURS = 48;
const MAX_EMAILS_FETCHED = 20;

/* ---------------------------------------------------------------------------
 * Utilidades de texto
 * ------------------------------------------------------------------------- */
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
}

function cleanHtml(html) {
  if (!html) return '';
  const noStyles = html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(noStyles).replace(/[\u00A0\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDigits(raw) {
  return (raw || '').replace(/[\s\u00A0\-]/g, '');
}

function looksLikeYear(digits) {
  if (digits.length !== 4) return false;
  const n = parseInt(digits, 10);
  return n >= 1900 && n <= 2099;
}

/* ---------------------------------------------------------------------------
 * Extração via DOM — a Netflix coloca o código num <td class="lrg-number">
 * sem a palavra "código" por perto, então o regex textual não pega.
 * ------------------------------------------------------------------------- */
function extractCodeFromHtml(html, platform) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const expectedLengths = PLATFORMS[platform]?.codeLengths || [4, 6, 8];

  const selectors = [];
  if (platform === 'netflix') {
    selectors.push('.lrg-number', '[class*="lrg-number"]', '[class*="code-number"]');
  }
  selectors.push('[class*="verification-code"]', '[class*="otp-code"]', '[class*="access-code"]');

  for (const sel of selectors) {
    const found = $(sel).first().text();
    const digits = cleanDigits(found);
    if (expectedLengths.includes(digits.length) && !looksLikeYear(digits)) {
      console.log(`[DEBUG][${platform}] código encontrado via seletor "${sel}": ${digits}`);
      return digits;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Extração do código (texto)
 * ------------------------------------------------------------------------- */
const CODE_REGEX = /(?:c[oó]digo(?:\s+(?:de\s+)?(?:acesso|verifica[cç][aã]o|temporal|tempor[aá]rio|seguran[cç]a|seguranca|acesso\s+tempor[aá]rio))?|temporary\s+access\s+code|access\s+code|verification\s+code|security\s+code|one[-\s]?time\s+(?:passcode|password|code)|use\s+(?:este\s+)?c[oó]digo|insira\s+(?:este\s+)?c[oó]digo)[\s:.\u00A0\-]{0,40}((?:\d[\s\u00A0]?){4,8})\b/gi;

function extractCode(text, platform) {
  const clean = cleanHtml(text);
  if (!clean) return null;
  const expectedLengths = PLATFORMS[platform]?.codeLengths || [4, 6, 8];

  CODE_REGEX.lastIndex = 0;
  let match;
  while ((match = CODE_REGEX.exec(clean)) !== null) {
    const digits = cleanDigits(match[1]);
    if (expectedLengths.includes(digits.length) && !looksLikeYear(digits)) return digits;
  }

  const fallback = /(?:c[oó]digo|code)\s*[:=]\s*((?:\d[\s\u00A0]?){4,8})\b/gi;
  fallback.lastIndex = 0;
  while ((match = fallback.exec(clean)) !== null) {
    const digits = cleanDigits(match[1]);
    if (expectedLengths.includes(digits.length) && !looksLikeYear(digits)) return digits;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Seguir link de "receber código"
 * ------------------------------------------------------------------------- */
function isTrustedLink(url, platform) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (PLATFORMS[platform].trustedDomains || []).some((d) => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

async function findCodeViaLink(htmlContent, platform) {
  if (!htmlContent) return null;
  const $ = cheerio.load(htmlContent);
  let link = null;
  $('a').each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (href && /c[oó]digo|receber|obter|get\s+code|access/i.test(text)) { link = href; return false; }
  });
  if (!link || !isTrustedLink(link, platform)) {
    console.log(`[DEBUG][${platform}] Nenhum link confiável de código encontrado.`);
    return null;
  }
  console.log(`[DEBUG][${platform}] Seguindo link confiável: ${link}`);
  try {
    const resp = await axios.get(link, {
      timeout: 10000, maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      validateStatus: () => true,
    });
    if (resp.status < 200 || resp.status >= 400) return null;
    return extractCode(String(resp.data), platform);
  } catch (e) {
    console.log(`[DEBUG][${platform}] Erro ao seguir link: ${e.message}`);
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * IMAP
 * ------------------------------------------------------------------------- */
function parseEmail(stream) {
  return new Promise((resolve, reject) => {
    simpleParser(stream, (err, parsed) => { if (err) return reject(err); resolve(parsed); });
  });
}

function searchEmails(emailAddress, platform) {
  const cfg = PLATFORMS[platform];
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST || 'imail.hostinger.com',
      port: parseInt(process.env.IMAP_PORT, 10) || 993,
      tls: true, tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000, connTimeout: 20000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const since = new Date();
        since.setHours(since.getHours() - SEARCH_WINDOW_HOURS);
        imap.search([['SINCE', since]], (err, uids) => {
          console.log(`[DEBUG][${platform}] IMAP SINCE ${since.toISOString()} -> ${uids ? uids.length : 0} e-mail(s).`);
          if (err || !uids || uids.length === 0) { imap.end(); return resolve({ found: false, code: null }); }
          const toFetch = uids.slice(-MAX_EMAILS_FETCHED).reverse();
          const fetch = imap.fetch(toFetch, { bodies: '' });
          const emailPromises = [];

          fetch.on('message', (msg) => {
            emailPromises.push(new Promise((res) => {
              msg.on('body', async (stream) => {
                try {
                  const parsed = await parseEmail(stream);
                  const toAddrs = (parsed.to?.value || []).map((v) => (v.address || '').toLowerCase());
                  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
                  if (!toAddrs.some((a) => a === emailAddress.toLowerCase())) return res(null);
                  if (!cfg.senders.some((s) => fromAddr.includes(s.split('@')[1]))) return res(null);
                  console.log(`[DEBUG][${platform}] de="${fromAddr}" assunto="${parsed.subject}"`);

                  let code = extractCodeFromHtml(parsed.html || '', platform);
                  console.log(`[DEBUG][${platform}] código no DOM? ${code || 'NÃO'}`);
                  if (!code) {
                    const combined = `${parsed.text || ''} ${parsed.html || ''}`;
                    code = extractCode(combined, platform);
                    console.log(`[DEBUG][${platform}] código no texto? ${code || 'NÃO'}`);
                  }
                  if (!code) {
                    code = await findCodeViaLink(parsed.html || '', platform);
                    console.log(`[DEBUG][${platform}] código via link? ${code || 'NÃO'}`);
                  }
                  if (!code) return res(null);
                  res({ code, date: parsed.date ? new Date(parsed.date).getTime() : 0 });
                } catch (e) {
                  console.log(`[DEBUG][${platform}] erro ao parsear e-mail: ${e.message}`);
                  res(null);
                }
              });
            }));
          });

          fetch.once('end', async () => {
            try {
              const resultados = (await Promise.all(emailPromises)).filter(Boolean);
              resultados.sort((a, b) => b.date - a.date);
              const maisRecente = resultados[0] || null;
              imap.end();
              resolve({ found: !!maisRecente, code: maisRecente ? maisRecente.code : null });
            } catch (e) { imap.end(); reject(e); }
          });
          fetch.once('error', (err) => { imap.end(); reject(err); });
        });
      });
    });
    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

/* ---------------------------------------------------------------------------
 * Rotas
 * ------------------------------------------------------------------------- */
app.post('/api/buscar', async (req, res) => {
  const { email, platform } = req.body || {};
  if (!email || !platform) return res.status(400).json({ error: 'E-mail e plataforma são obrigatórios.' });
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Plataforma inválida.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  try {
    const result = await searchEmails(email, platform);
    if (result.found && result.code) return res.json({ success: true, code: result.code });
    return res.json({ success: false, message: `Nenhum código encontrado nas últimas ${SEARCH_WINDOW_HOURS}h para este e-mail.` });
  } catch (err) {
    console.error('Erro IMAP:', err.message);
    return res.status(500).json({ error: 'Erro ao conectar ao servidor de e-mail. Tente novamente.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', platforms: VALID_PLATFORMS }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ClickFS server rodando na porta ${PORT}`));
