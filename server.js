const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
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
  globoplay: ['noreply@globo.com', 'globoplay@globo.com', 'no-reply@globoplay.com'],
};

// Padrões para extrair código — ordem importa: mais específico primeiro
const CODE_PATTERNS = [
  /código[:\s]+(\d{6})\b/gi,
  /código[:\s]+(\d{4})\b/gi,
  /code[:\s]+(\d{6})\b/gi,
  /code[:\s]+(\d{4})\b/gi,
  /\b(\d{6})\b/g,
  /\b(\d{4})\b/g,
];

function extractCode(text) {
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const pattern of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(clean);
    if (match) return match[1];
  }
  return null;
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
      host: process.env.IMAP_HOST || 'imap.hostinger.com',
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

                  const toAddresses = (parsed.to?.value || []).map(v => v.address.toLowerCase());
                  const isForThisUser = toAddresses.some(addr => addr === emailAddress.toLowerCase());
                  if (!isForThisUser) return res(null);

                  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
                  const isFromStreaming = senders.length === 0 || senders.some(s => fromAddr.includes(s.split('@')[1]));
                  if (!isFromStreaming) return res(null);

                  const textContent = parsed.text || '';
                  const htmlContent = parsed.html || '';
                  const combined = textContent + ' ' + htmlContent;
                  const code = extractCode(combined);
                  res(code || null);
                } catch (e) {
                  res(null);
                }
              });
            });
            emailPromises.push(promise);
          });

          fetch.once('end', async () => {
            try {
              const codes = await Promise.all(emailPromises);
              const foundCode = codes.find(c => c !== null) || null;
              imap.end();
              resolve({ found: !!foundCode, code: foundCode });
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

app.post('/api/buscar', async (req, res) => {
  const { email, platform } = req.body;

  if (!email || !platform) {
    return res.status(400).json({ error: 'E-mail e plataforma são obrigatórios.' });
  }

  const validPlatforms = ['netflix', 'disney', 'max', 'globoplay'];
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
