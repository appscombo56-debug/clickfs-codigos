// acesso.js — controle de acesso por chave (uma chave por conta de streaming)
//
// Como funciona:
//  - Cada conta (e-mail do streaming) tem UMA chave e uma data de expiração.
//  - /api/buscar só libera o código se e-mail + chave baterem e a data não tiver passado.
//  - Ao vencer, a chave é TROCADA automaticamente. Quem não renovar fica com a chave antiga, que não funciona mais.
//  - Você gerencia tudo no painel /admin (protegido por ADMIN_PASSWORD).
//
// Variáveis de ambiente (Render > Environment):
//  DATABASE_URL    -> string de conexão do Postgres (Supabase, Neon, Render Postgres...)
//  ADMIN_PASSWORD  -> senha do painel /admin
//  DIAS_ACESSO     -> (opcional) dias de validade, padrão 30

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const DIAS_PADRAO = Number(process.env.DIAS_ACESSO || 30);
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para evitar confusão

const usaSSL =
  process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usaSSL ? { rejectUnauthorized: false } : false,
});

// ---------- utilidades ----------

function gerarChave() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
  return s; // 6 caracteres, ex.: K7M29Q
}

const normEmail = (v) => String(v || '').trim().toLowerCase();
const normChave = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '');

function iguais(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- limite de tentativas erradas ----------

const falhas = new Map(); // chave -> { n, desde }
const JANELA_MS = 15 * 60 * 1000;
const MAX_POR_PAR = 5; // ip + e-mail
const MAX_POR_IP = 20;

function contar(k) {
  const f = falhas.get(k);
  if (!f) return 0;
  if (Date.now() - f.desde > JANELA_MS) {
    falhas.delete(k);
    return 0;
  }
  return f.n;
}

function somar(k) {
  const f = falhas.get(k);
  if (!f || Date.now() - f.desde > JANELA_MS) falhas.set(k, { n: 1, desde: Date.now() });
  else f.n += 1;
}

const bloqueado = (ip, email) =>
  contar(`${ip}|${email}`) >= MAX_POR_PAR || contar(`ip|${ip}`) >= MAX_POR_IP;

function registrarFalha(ip, email) {
  somar(`${ip}|${email}`);
  somar(`ip|${ip}`);
}

setInterval(() => {
  for (const [k, f] of falhas) if (Date.now() - f.desde > JANELA_MS) falhas.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- banco ----------

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas (
      email       TEXT PRIMARY KEY,
      chave       TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      rotacionada BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Troca a chave de toda conta vencida (uma única vez por vencimento)
async function rotacionarVencidas() {
  try {
    const { rows } = await pool.query(
      'SELECT email FROM contas WHERE expires_at < now() AND rotacionada = FALSE'
    );
    for (const r of rows) {
      await pool.query(
        'UPDATE contas SET chave = $1, rotacionada = TRUE WHERE email = $2 AND rotacionada = FALSE',
        [gerarChave(), r.email]
      );
      console.log(`[acesso] chave trocada (vencida): ${r.email}`);
    }
  } catch (e) {
    console.error('[acesso] erro ao trocar chaves vencidas:', e.message);
  }
}

// ---------- middleware para o /api/buscar ----------

async function verificarAcesso(req, res, next) {
  try {
    const email = normEmail(req.body && req.body.email);
    const chave = normChave(req.body && req.body.chave);
    const ip = req.ip;

    if (!email || !chave) {
      return res
        .status(400)
        .json({ success: false, message: 'Informe o e-mail e a chave de acesso.' });
    }

    if (bloqueado(ip, email)) {
      return res.status(429).json({
        success: false,
        message: 'Muitas tentativas incorretas. Aguarde 15 minutos e tente de novo.',
      });
    }

    const { rows } = await pool.query(
      'SELECT chave, expires_at FROM contas WHERE email = $1',
      [email]
    );
    const conta = rows[0];
    const ok = conta && iguais(conta.chave, chave) && new Date(conta.expires_at) > new Date();

    if (!ok) {
      registrarFalha(ip, email);
      return res.status(401).json({
        success: false,
        message: 'Acesso inválido ou expirado. Fale com o suporte para renovar.',
      });
    }

    falhas.delete(`${ip}|${email}`);
    req.body.email = email; // e-mail já normalizado para o seu handler
    next();
  } catch (e) {
    console.error('[acesso] erro:', e);
    res.status(500).json({ success: false, message: 'Erro interno. Tente novamente.' });
  }
}

// ---------- painel admin ----------

const admin = express.Router();
admin.use(express.json());
admin.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

admin.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

function autenticarAdmin(req, res, next) {
  const senha = process.env.ADMIN_PASSWORD;
  if (!senha) return res.status(503).json({ erro: 'ADMIN_PASSWORD não configurada no servidor.' });

  const ip = req.ip;
  if (contar(`admin|${ip}`) >= 10) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  if (!iguais(req.get('x-admin-password') || '', senha)) {
    somar(`admin|${ip}`);
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  next();
}

admin.use('/api', autenticarAdmin);

const diasDe = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : DIAS_PADRAO;
};

admin.get('/api/contas', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email, chave, expires_at, rotacionada, created_at FROM contas ORDER BY expires_at ASC'
  );
  res.json(rows);
});

admin.post('/api/contas', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO contas (email, chave, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3::int))
       RETURNING email, chave, expires_at, rotacionada`,
      [email, gerarChave(), diasDe(req.body.dias)]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Essa conta já está cadastrada.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cadastrar.' });
  }
});

// Renovar: soma os dias à data atual de vencimento (ou a partir de hoje, se já venceu).
// A chave NÃO muda aqui: se a conta já venceu, ela já foi trocada automaticamente.
admin.post('/api/contas/renovar', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE contas
        SET expires_at = GREATEST(expires_at, now()) + make_interval(days => $2::int),
            rotacionada = FALSE
      WHERE email = $1
      RETURNING email, chave, expires_at, rotacionada`,
    [normEmail(req.body.email), diasDe(req.body.dias)]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'Conta não encontrada.' });
  res.json(rows[0]);
});

admin.post('/api/contas/trocar-chave', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE contas SET chave = $2 WHERE email = $1 RETURNING email, chave, expires_at, rotacionada',
    [normEmail(req.body.email), gerarChave()]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'Conta não encontrada.' });
  res.json(rows[0]);
});

admin.post('/api/contas/remover', async (req, res) => {
  await pool.query('DELETE FROM contas WHERE email = $1', [normEmail(req.body.email)]);
  res.json({ ok: true });
});

// ---------- instalação no seu servidor ----------

async function montar(app) {
  // Hospedagem fica atrás de proxy: necessário para pegar o IP real do cliente.
  // Se todos os acessos parecerem vir do mesmo IP, ajuste TRUST_PROXY no .env (ex.: 2).
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  await iniciarBanco();
  app.use('/admin', admin);
  await rotacionarVencidas();
  setInterval(rotacionarVencidas, 10 * 60 * 1000).unref();
  console.log('[acesso] controle de acesso ativo (painel em /admin)');
}

module.exports = { montar, verificarAcesso };
