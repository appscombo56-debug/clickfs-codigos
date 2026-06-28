const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Streaming platforms config - remetentes esperados
const STREAMING_SENDERS = {
  netflix: ['info@account.netflix.com', 'netflix@mailer.netflix.com', 'no-reply@netflix.com'],
  disney: ['disneyplus@mail.disneyplus.com', 'no-reply@disneyplus.com', 'disneyplus@emails.disneyplus.com'],
  max: ['no-reply@max.com', 'hbomax@mail.hbomax.com', 'max@email.max.com'],
  globoplay: ['noreply@globo.com', 'globoplay@globo.com', 'no-reply@globoplay.com'],
};

// Palavras-chave para encontrar o código no e-mail
const CODE_PATTERNS = [
  /\b([A-Z0-9]{6,8})\b/g,           // Código maiúsculo 6-8 chars
  /código[:\s]+([A-Z0-9]{4,8})/gi,   // "código: XXXXXX"
  /code[:\s]+([A-Z0-9]{4,8})/gi,     // "code: XXXXXX"
  /(\d{4,8})/g,                       // Somente números 4-8 dígitos
];

function extractCode(text) {
  for (const pattern of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
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
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        // Busca e-mails das últimas 24h para o email do cliente
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

          // Pegar os mais recentes (últimos 5)
          const toFetch = results.slice(-5).reverse();
          const fetch = imap.fetch(toFetch, { bodies: '' });
          let found = false;
          let foundCode = null;

          fetch.on('message', (msg) => {
            if (found) return;
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (err || found) return;

                const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
                const isFromStreaming = senders.length === 0 || senders.some(s => fromAddr.includes(s.split('@')[1]));

                if (isFromStreaming) {
                  const textContent = parsed.text || '';
                  const htmlContent = parsed.html || '';
                  const combined = textContent + ' ' + htmlContent.replace(/<[^>]+>/g, ' ');
                  const code = extractCode(combined);
                  if (code) {
                    found = true;
                    foundCode = code;
                  }
                }
              });
            });
          });

          fetch.once('end', () => {
            setTimeout(() => {
              imap.end();
              resolve({ found: found, code: foundCode });
            }, 500);
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

// Rota principal de busca
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
