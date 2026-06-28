const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else if (fs.existsSync(rootIndex)) {
    res.sendFile(rootIndex);
  } else {
    res.send('ClickFS Códigos online!');
  }
});

const BEFORE_CODE = [
  'código de acesso único',
  'código de acesso',
  'seu código',
  'código único',
  'verification code',
  'access code',
  'one-time code',
  'código:',
  'code:',
  'PIN:',
  'OTP:',
];

function extractCode(text) {
  const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  for (const keyword of BEFORE_CODE) {
    const regex = new RegExp(keyword + '[\\s:]*([0-9]{4,8})', 'gi');
    const match = regex.exec(cleaned);
    if (match) return match[1];
  }

  const sixDigit = /\b([0-9]{6})\b/g;
  let match;
  const candidates = [];
  while ((match = sixDigit.exec(cleaned)) !== null) {
    candidates.push(match[1]);
  }
  for (const c of candidates) {
    if (!c.match(/^202[0-9]$/)) return c;
  }

  const otherDigit = /\b([0-9]{4}|[0-9]{8})\b/g;
  while ((match = otherDigit.exec(cleaned)) !== null) {
    const n = match[1];
    if (!n.match(/^202[0-9]$/)) return n;
  }

  return null;
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
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const searchCriteria = [['SINCE', yesterday], ['TO', emailAddress]];

        imap.search(searchCriteria, (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve({ found: false, code: null });
          }

          const toFetch = results.slice(-10).reverse();
          const fetch = imap.fetch(toFetch, { bodies: '' });
          let found = false;
          let foundCode = null;
          let pending = toFetch.length;

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                pending--;
                if (err || found) {
                  if (pending === 0) { imap.end(); resolve({ found, code: foundCode }); }
                  return;
                }

                const textContent = parsed.text || '';
                const htmlContent = parsed.html || '';
                const combined = textContent + ' ' + htmlContent;
                const code = extractCode(combined);

                if (code && !found) {
                  found = true;
                  foundCode = code;
                }

                if (pending === 0) {
                  setTimeout(() => { imap.end(); resolve({ found, code: foundCode }); }, 300);
                }
              });
            });
          });

          fetch.once('end', () => {
            setTimeout(() => {
              if (!found) { imap.end(); resolve({ found: false, code: null }); }
            }, 3000);
          });

          fetch.once('error', (err) => { imap.end(); reject(err); });
        });
      });
    });

    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

app.post('/api/buscar', async (req, res) => {
  const { email, platform } = req.body;
  if (!email || !platform) return res.status(400).json({ error: 'E-mail e plataforma são obrigatórios.' });
  const validPlatforms = ['netflix', 'disney', 'max', 'globoplay'];
  if (!validPlatforms.includes(platform)) return res.status(400).json({ error: 'Plataforma inválida.' });

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
