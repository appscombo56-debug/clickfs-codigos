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
    res.send('ClickFS Codigos online!');
  }
});

const BEFORE_CODE = [
  'codigo de acesso unico',
  'codigo de acesso',
  'seu codigo',
  'codigo unico',
  'verification code',
  'access code',
  'one-time code',
  'codigo:',
  'code:',
  'PIN:',
  'OTP:',
];

const INVALID_CODES = new Set([
  '000000','111111','222222','333333','444444','555555',
  '666666','777777','888888','999999','123456','012345',
  '2020','2021','2022','2023','2024','2025','2026','2027','2028','2029',
]);

function isValidCode(code) {
  if (INVALID_CODES.has(code)) return false;
  if (/^(\d)\1+$/.test(code)) return false;
  if (/^202[0-9]/.test(code) && code.length === 4) return false;
  return true;
}

function extractCode(rawText, rawHtml) {
  const text = (rawText || '').replace(/\s+/g, ' ');
  
  for (const keyword of BEFORE_CODE) {
    const regex = new RegExp(keyword + '[\\s:]*([0-9]{4,8})', 'gi');
    const match = regex.exec(text);
    if (match && isValidCode(match[1])) return match[1];
  }

  const sixDigit = /\b([0-9]{6})\b/g;
  let match;
  while ((match = sixDigit.exec(text)) !== null) {
    if (isValidCode(match[1])) return match[1];
  }

  const html = (rawHtml || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  for (const keyword of BEFORE_CODE) {
    const regex = new RegExp(keyword + '[\\s:]*([0-9]{4,8})', 'gi');
    const match2 = regex.exec(html);
    if (match2 && isValidCode(match2[1])) return match2[1];
  }

  const sixDigit2 = /\b([0-9]{6})\b/g;
  while ((match = sixDigit2.exec(html)) !== null) {
    if (isValidCode(match[1])) return match[1];
  }

  const fourDigit = /\b([0-9]{4})\b/g;
  while ((match = fourDigit.exec(text)) !== null) {
    if (isValidCode(match[1])) return match[1];
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

                const code = extractCode(parsed.text, parsed.html);
                console.log('Email para:', emailAddress, '| Codigo extraido:', code);

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
  if (!email || !platform) return res.status(400).json({ error: 'E-mail e plataforma sao obrigatorios.' });
  const validPlatforms = ['netflix', 'disney', 'max', 'globoplay'];
  if (!validPlatforms.includes(platform)) return res.status(400).json({ error: 'Plataforma invalida.' });

  try {
    const result = await searchEmails(email, platform);
    if (result.found && result.code) {
      return res.json({ success: true, code: result.code });
    } else {
      return res.json({ success: false, message: 'Nenhum codigo encontrado nas ultimas 24h para este e-mail.' });
    }
  } catch (err) {
    console.error('Erro IMAP:', err.message);
    return res.status(500).json({ error: 'Erro ao conectar ao servidor de e-mail. Tente novamente.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ClickFS server rodando na porta ' + PORT));
