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
  netflix:   ['netflix.com'],
  disney:    ['disneyplus.com', 'disney.com'],
  max:       ['max.com', 'hbomax.com'],
  primevideo: ['amazon.com', 'primevideo.com'],
};

// Padrões atualizados e flexibilizados por plataforma
const CODE_PATTERNS_BY_PLATFORM = {
  netflix: [
    // Padrão específico para pegar números de 4 dígitos isolados em tags HTML (ex: <td ...> 0929 </td>)
    /<td[^>]*>\s*(\d{4})\s*<\/td>/gi,
    // Padrões textuais flexíveis (4 dígitos)
    /(?:c[oó]digo|c[oó]digo de acesso|access code|utilize|use)[^\d]{0,100}\b(\d{4})\b/gi,
    /acesso tempor[aá]rio[^\d]{0,100}\b(\d{4})\b/gi,
    // Busca por qualquer sequência de 4 dígitos próximos à palavra código/code
    /\b(\d{4})\b/gi, 
  ],
  disney: [
    // Padrão específico para pegar números de 6 dígitos isolados em tags HTML (ex: <td ...> 977081 </td>)
    /<td[^>]*>\s*(\d{6})\s*<\/td>/gi,
    // Padrões textuais flexíveis (6 dígitos)
    /(?:c[oó]digo|c[oó]digo de verifica[cç][aã]o|passcode|code|security code)[^\d]{0,100}\b(\d{6})\b/gi,
    /\b(\d{6})\b/gi,
  ],
  max: [
    /(?:insira este c[oó]digo|c[oó]digo|enter this code)[^\d]{0,50}\b(\d{6})\b/gi,
    /\b(\d{6})\b/gi,
  ],
  primevideo: [
    /(?:verificar sua identidade|c[oó]digo de verifica[cç][aã]o|verification code|one[- ]?time password|otp)[^\d]{0,50}\b(\d{6})\b/gi,
    /\b(\d{6})\b/gi,
  ],
};

// Fallback genérico para capturar 4 ou 6 dígitos
const GENERIC_FALLBACK = [
  /\b(\d{6})\b/g,
  /\b(\d{4})\b/g,
];

function pareceAno(numeroLimpo) {
  const n = parseInt(numeroLimpo, 10);
  return numeroLimpo.length === 4 && n >= 1900 && n <= 2099;
}

function extractCode(htmlContent, textContent, platform) {
  // 1. Tentar extrair diretamente no HTML usando Cheerio (Análise Estrutural exata)
  if (htmlContent) {
    const $ = cheerio.load(htmlContent);
    
    // Netflix: procura células TD que contêm exatamente 4 dígitos com ou sem espaços
    if (platform === 'netflix') {
      let result = null;
      $('td').each((_, el) => {
        const text = $(el).text().trim();
        if (/^\d{4}$/.test(text) && !pareceAno(text)) {
          result = text;
          return false; // quebra o loop
        }
      });
      if (result) return result;
    }

    // Disney: procura células TD que contêm exatamente 6 dígitos
    if (platform === 'disney') {
      let result = null;
      $('td').each((_, el) => {
        const text = $(el).text().trim();
        if (/^\d{6}$/.test(text)) {
          result = text;
          return false; // quebra o loop
        }
      });
      if (result) return result;
    }
  }

  // 2. Tentar via Regex no HTML bruto para capturar marcas estruturais
  const patternsEspecificos = CODE_PATTERNS_BY_PLATFORM[platform] || [];
  for (const pattern of patternsEspecificos) {
    pattern.lastIndex = 0;
    const match = pattern.exec(htmlContent);
    if (match) {
      const numeroLimpo = match[1].replace(/\s+/g, '');
      if (!pareceAno(numeroLimpo)) return numeroLimpo;
    }
  }

  // 3. Tentar no Texto limpo (Normalizado)
  const cleanText = (textContent || htmlContent.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  for (const pattern of patternsEspecificos) {
    pattern.lastIndex = 0;
    const match = pattern.exec(cleanText);
    if (match) {
      const numeroLimpo = match[1].replace(/\s+/g, '');
      if (!pareceAno(numeroLimpo)) return numeroLimpo;
    }
  }

  // 4. Fallback Genérico
  for (const pattern of GENERIC_FALLBACK) {
    pattern.lastIndex = 0;
    const match = pattern.exec(cleanText);
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

async function buscarCodigoViaLink(htmlContent, platform) {
  if (!htmlContent) return null;

  const $ = cheerio.load(htmlContent);
  let link = null;

  $('a').each((_, el) => {
    const texto = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (href && /c[oó]digo|receber|get code|obter/.test(texto)) {
      link = href;
      return false;
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
    return extractCode(String(resp.data), '', platform);
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

        const allowedDomains = STREAMING_SENDERS[platform] || [];
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
                  const isFromStreaming = allowedDomains.some(domain => fromAddr.includes(domain));

                  if (!isFromStreaming) {
                    return res(null);
                  }

                  // Extrair código
                  const textContent = parsed.text || '';
                  const htmlContent = parsed.html || '';

                  let code = extractCode(htmlContent, textContent, platform);

                  // Fallback para e-mails que trazem botão de confirmação
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
