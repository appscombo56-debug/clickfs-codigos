const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Remetentes esperados por plataforma
const STREAMING_SENDERS = {
  netflix:    ['netflix.com'],
  disney:     ['disneyplus.com', 'disney.com', 'mail.disneyplus.com', 'emails.disneyplus.com'],
  max:        ['no-reply@max.com', 'hbomax@mail.hbomax.com', 'max@email.max.com'],
  primevideo: ['account-update@amazon.com', 'no-reply@amazon.com', 'auto-confirm@amazon.com', 'primevideo@amazon.com'],
};

// Padrões para extrair código
const CODE_PATTERNS_BY_PLATFORM = {
  netflix: [
    /<td[^>]*>\s*(\d{4})\s*<\/td>/gi,
    /(?:c[oó]digo|c[oó]digo de acesso|access code|utilize|use)[^\d]{0,100}\b(\d{4})\b/gi,
    /acesso tempor[aá]rio[^\d]{0,100}\b(\d{4})\b/gi,
    /\b(\d{4})\b/gi, 
  ],
  disney: [
    /<td[^>]*>\s*(\d{6})\s*<\/td>/gi,
    /c[oó]digo[^\d]{0,50}(\d{6})\b/gi,
    /security code[^\d]{0,50}(\d{6})\b/gi,
    /passcode[^\d]{0,50}(\d{6})\b/gi,
  ],
  max: [
    /insira este c[oó]digo[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /c[oó]digo[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /enter this code[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
  ],
  primevideo: [
    /verificar sua identidade[^\d]{0,40}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /c[oó]digo de verifica[cç][aã]o[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /verification code[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /one[- ]?time password[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /c[oó]digo[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
  ],
};

const GENERIC_FALLBACK = [
  /c[oó]digo[:\s]+(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
  /c[oó]digo[:\s]+(\d\s?\d\s?\d\s?\d)\b/gi,
  /code[:\s]+(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
  /code[:\s]+(\d\s?\d\s?\d\s?\d)\b/gi,
];

function pareceAno(numeroLimpo) {
  const n = parseInt(numeroLimpo, 10);
  return numeroLimpo.length === 4 && n >= 1900 && n <= 2099;
}

function extractCode(htmlContent, textContent, platform) {
  // 1. Busca Direta Estruturada via Cheerio para Netflix e Disney
  if (htmlContent && (platform === 'netflix' || platform === 'disney')) {
    const $ = cheerio.load(htmlContent);
    
    if (platform === 'netflix') {
      let result = null;
      $('td').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, '');
        if (/^\d{4}$/.test(text) && !pareceAno(text)) {
          result = text;
          return false;
        }
      });
      if (result) return result;
    }

    if (platform === 'disney') {
      let result = null;
      $('td').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, '');
        if (/^\d{6}$/.test(text)) {
          result = text;
          return false;
        }
      });
      if (result) return result;
    }
  }

  // 2. Busca por Regex no HTML Bruto
  if (htmlContent) {
    const patternsEspecificos = CODE_PATTERNS_BY_PLATFORM[platform] || [];
    for (const pattern of patternsEspecificos) {
      pattern.lastIndex = 0;
      const match = pattern.exec(htmlContent);
      if (match) {
        const numeroLimpo = match[1].replace(/\s+/g, '');
        if (!pareceAno(numeroLimpo)) return numeroLimpo;
      }
    }
  }

  // 3. Lógica por Texto Limpo
  const textToSearch = textContent || htmlContent || '';
  const clean = textToSearch.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const patternsEspecificos = CODE_PATTERNS_BY_PLATFORM[platform] || [];
  for (const pattern of patternsEspecificos) {
    pattern.lastIndex = 0;
    const match = pattern.exec(clean);
    if (match) {
      const numeroLimpo = match[1].replace(/\s+/g, '');
      if (!pareceAno(numeroLimpo)) return numeroLimpo;
    }
  }

  for (const pattern of GENERIC_FALLBACK) {
    pattern.lastIndex = 0;
    const match = pattern.exec(clean);
    if (match) {
      const numeroLimpo = match[1].replace(/\s+/g, '');
      if (!pareceAno(numeroLimpo)) return numeroLimpo;
    }
  }

  return null;
}

// Domínios confiáveis por plataforma
const DOMINIOS_CONFIAVEIS = {
  netflix:    ['netflix.com'],
  disney:     ['disneyplus.com', 'disney.com'],
  max:        ['max.com', 'hbomax.com'],
  primevideo: ['amazon.com', 'amazon.com.br', 'primevideo.com'],
};

function linkEhConfiavel(url, platform) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const permitidos = DOMINIOS_CONFIAVEIS[platform] || [];
    return permitidos.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Função para abrir o link do e-mail e buscar o código da página renderizada
async function buscarCodigoViaLink(htmlContent, platform) {
  if (!htmlContent) return null;

  const $ = cheerio.load(htmlContent);
  let link = null;

  $('a').each((_, el) => {
    const texto = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (href && (texto.includes('receber') || texto.includes('código') || texto.includes('codigo') || texto.includes('get code') || texto.includes('obter'))) {
      link = href.replace(/&amp;/g, '&');
      return false;
    }
  });

  if (!link || !linkEhConfiavel(link, platform)) return null;

  try {
    const resp = await axios.get(link, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 400) return null;

    const bodyHtml = String(resp.data);
    const $page = cheerio.load(bodyHtml);

    // Específico para Netflix Acesso Temporário (Baseado na captura da inspeção)
    if (platform === 'netflix') {
      // 1. Procura pelo atributo data-uia exato
      let travelOtp = $page('[data-uia="travel-verification-otp"]').text().trim().replace(/\s+/g, '');
      if (/^\d{4}$/.test(travelOtp) && !pareceAno(travelOtp)) {
        return travelOtp;
      }

      // 2. Procura pela classe challenge-code
      let challengeOtp = $page('.challenge-code').text().trim().replace(/\s+/g, '');
      if (/^\d{4}$/.test(challengeOtp) && !pareceAno(challengeOtp)) {
        return challengeOtp;
      }
    }

    // Tenta fallback padrão de extração no HTML de destino se a estrutura acima falhar
    let code = extractCode(bodyHtml, '', platform);

    if (!code && platform === 'netflix') {
      const matches = bodyHtml.match(/\b(\d{4})\b/g);
      if (matches) {
        for (const m of matches) {
          if (!pareceAno(m)) {
            code = m;
            break;
          }
        }
      }
    }

    return code;
  } catch (e) {
    console.error('Erro ao acessar link do e-mail:', e.message);
    return null;
  }
}

function parseEmailAsync(stream) {
  return new Promise((resolve, reject) => {
    simpleParser(stream, (err, parsed) => {
      if (err) return reject(err);
      resolve(parsed);
    });
  });
}

function searchEmails(emailAddress, platform) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST || 'imail.hostinger.com',
      port: parseInt(process.env.IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, async (err, box) => {
        if (err) { imap.end(); return reject(err); }

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const senders = STREAMING_SENDERS[platform] || [];
        const searchCriteria = [
          ['SINCE', yesterday],
          ['TO', emailAddress],
        ];

        imap.search(searchCriteria, (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve({ found: false, code: null });
          }

          const toFetch = results.slice(-5).reverse();
          const fetch = imap.fetch(toFetch, { bodies: '' });

          const emailPromises = [];

          fetch.on('message', (msg) => {
            const promise = new Promise((res) => {
              msg.on('body', async (stream) => {
                try {
                  const parsed = await parseEmailAsync(stream);

                  // Verificar destinatário
                  const toAddresses = (parsed.to?.value || []).map(v => v.address.toLowerCase());
                  const isForThisUser = toAddresses.some(addr => addr === emailAddress.toLowerCase());

                  if (!isForThisUser) {
                    return res(null);
                  }

                  // Verificar remetente
                  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
                  const isFromStreaming = senders.length === 0 || senders.some(s => fromAddr.includes(s.includes('@') ? s.split('@')[1] : s));

                  if (!isFromStreaming) {
                    return res(null);
                  }

                  // Extrair código
                  const textContent = parsed.text || '';
                  const htmlContent = parsed.html || '';

                  let code = extractCode(htmlContent, textContent, platform);

                  // Se não encontrou no texto/HTML do e-mail, acessa o link
                  if (!code) {
                    code = await buscarCodigoViaLink(htmlContent, platform);
                  }

                  if (!code) return res(null);
                  res({ code, date: parsed.date ? new Date(parsed.date).getTime() : 0 });
                } catch (e) {
                  res(null);
                }
              });
            });
            emailPromises.push(promise);
          });

          fetch.once('end', async () => {
            try {
              const resultados = await Promise.all(emailPromises);
              const validos = resultados.filter(r => r !== null);
              validos.sort((a, b) => b.date - a.date);
              const maisRecente = validos[0] || null;
              imap.end();
              resolve({ found: !!maisRecente, code: maisRecente ? maisRecente.code : null });
            } catch (e) {
              imap.end();
              reject(e);
            }
          });

          fetch.once('error', (err) => {
            imap.end();
            reject(err);
          });
        });
      });
    });

    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

// Rota principal
app.post('/api/buscar', async (req, res) => {
  const { email, platform } = req.body;

  if (!email || !platform) {
    return res.status(400).json({ error: 'E-mail e plataforma são obrigatórios.' });
  }

  const validPlatforms = ['netflix', 'disney', 'max', 'primevideo'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida.' });
  }

  try {
    const result = await searchEmails(email, platform);
    if (result.found && result.code) {
      return res.json({ success: true, code: result.code });
    } else {
      return res.json({ success: false, message: 'Nenhum código encontrado nas últimas 24h para este e-mail.' });
    }
  } catch (err) {
    console.error('Erro IMAP:', err.message);
    return res.status(500).json({ error: 'Erro ao conectar ao servidor de e-mail. Tente novamente.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ClickFS server rodando na porta ${PORT}`));
