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
  netflix:   ['info@account.netflix.com', 'netflix@mailer.netflix.com', 'no-reply@netflix.com'],
  disney:    ['disneyplus@mail.disneyplus.com', 'no-reply@disneyplus.com', 'disneyplus@emails.disneyplus.com'],
  max:       ['no-reply@max.com', 'hbomax@mail.hbomax.com', 'max@email.max.com'],
  primevideo: ['account-update@amazon.com', 'no-reply@amazon.com', 'auto-confirm@amazon.com', 'primevideo@amazon.com'],
};

// Padrões para extrair código, POR PLATAFORMA — sempre exige uma palavra de contexto
// perto do número, para não confundir com ano, telefone, número de pedido, etc.
const CODE_PATTERNS_BY_PLATFORM = {
  netflix: [
    /acesso tempor[aá]rio\.?[^\d]{0,15}(\d\s?\d\s?\d\s?\d)\b/gi,
    /use este c[oó]digo[^\d]{0,150}(\d\s?\d\s?\d\s?\d)\b/gi,
    /c[oó]digo de acesso tempor[aá]rio[^\d]{0,150}(\d\s?\d\s?\d\s?\d)\b/gi,
    /temporary access code[^\d]{0,150}(\d\s?\d\s?\d\s?\d)\b/gi,
  ],
  disney: [
    /c[oó]digo[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
    /security code[^\d]{0,25}(\d\s?\d\s?\d\s?\d\s?\d\s?\d)\b/gi,
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

// Fallback genérico (só usado se nada acima bater) — ainda exige a palavra "código"/"code"
// por perto, e ignora números que "parecem" ano (19xx/20xx) para reduzir falso-positivo.
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

function extractCode(text, platform) {
  // Remove tags HTML e normaliza espaços antes de aplicar os regex
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const patternsEspecificos = CODE_PATTERNS_BY_PLATFORM[platform] || [];
  for (const pattern of patternsEspecificos) {
    pattern.lastIndex = 0;
    const match = pattern.exec(clean);
    if (match) {
      const numeroLimpo = match[1].replace(/\s+/g, ''); // junta dígitos espaçados (ex: "4 8 3 1" -> "4831")
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

// Domínios confiáveis por plataforma — só seguimos o link do botão "Receber código"
// se ele apontar para um desses domínios (evita seguir link malicioso/phishing).
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

// Alguns e-mails (ex: Netflix "código de acesso temporário") não trazem o código no
// texto — trazem um botão/link que abre uma página com o código. Essa função acha
// esse link dentro do HTML do e-mail e segue ele para pegar o código na página final.
async function buscarCodigoViaLink(htmlContent, platform) {
  if (!htmlContent) return null;

  const $ = cheerio.load(htmlContent);
  let link = null;

  $('a').each((_, el) => {
    const texto = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (href && /c[oó]digo|receber|get code|obter/.test(texto)) {
      link = href;
      return false; // para no primeiro achado
    }
  });

  if (!link || !linkEhConfiavel(link, platform)) return null;

  try {
    const resp = await axios.get(link, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      validateStatus: () => true,
    });
    if (resp.status < 200 || resp.status >= 400) return null;
    return extractCode(String(resp.data), platform);
  } catch (e) {
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

          // Pegar os 5 mais recentes
          const toFetch = results.slice(-5).reverse();
          const fetch = imap.fetch(toFetch, { bodies: '' });

          const emailPromises = [];

          fetch.on('message', (msg) => {
            const promise = new Promise((res) => {
              msg.on('body', async (stream) => {
                try {
                  const parsed = await parseEmailAsync(stream);

                  // Verificar destinatário: confirmar que o TO realmente contém o email do cliente
                  const toAddresses = (parsed.to?.value || []).map(v => v.address.toLowerCase());
                  const isForThisUser = toAddresses.some(addr => addr === emailAddress.toLowerCase());

                  if (!isForThisUser) {
                    return res(null); // e-mail não é para esse usuário
                  }

                  // Verificar remetente da plataforma correta
                  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
                  const isFromStreaming = senders.length === 0 || senders.some(s => fromAddr.includes(s.split('@')[1]));

                  if (!isFromStreaming) {
                    return res(null); // e-mail não é da plataforma certa
                  }

                  // Extrair código
                  const textContent = parsed.text || '';
                  const htmlContent = parsed.html || '';
                  const combined = textContent + ' ' + htmlContent;
                  let code = extractCode(combined, platform);

                  // Se não veio código no texto (ex: e-mail só tem um botão "Receber código"),
                  // tenta achar e seguir esse link automaticamente.
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
              // Aguarda TODOS os e-mails serem parseados, depois escolhe o de data mais recente
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
