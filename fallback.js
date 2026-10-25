// fallback.js — se o seu e-mail (IMAP) não achar o código, tenta os sites parceiros.
//
// Roda SÓ no servidor. Usuário/senha ficam em variáveis de ambiente (.env / painel da Discloud),
// nunca no index.html. Este módulo só é chamado depois de verificarAcesso (e-mail + chave válidos).
//
// Variáveis de ambiente:
//   FALLBACK_TIMEOUT_MS   -> tempo máximo por parceiro (padrão 20000)
//   MK_URL                -> ex.: https://mk-suporte-cod.discloud.app   (vazio = MK desligado)
//   MK_BUSCAR_PATH        -> (opcional) padrão /buscar
//   MK_PLATAFORMAS        -> (opcional) JSON com o valor do <select> do MK, ex.: {"netflix":"netflix","disney":"disney","max":"max"}
//   FLAVINHO_API          -> https://lglaqyufykdiwkhkttpw.supabase.co/functions/v1   (vazio = Flavinho desligado)
//   FLAVINHO_APIKEY       -> chave pública (sb_publishable_...) que o site deles já usa
//   FLAVINHO_TIPOS        -> (opcional) JSON nome nosso -> valor de "type", ex.: {"netflix":"netflix","disney":"disney","max":"hbo"}

const axios = require('axios');

const TIMEOUT = Number(process.env.FALLBACK_TIMEOUT_MS || 20000);
const CODIGO_OK = /^\d{4,8}$/; // só aceita código numérico; qualquer outra coisa é descartada

function mapaMK() {
  try {
    if (process.env.MK_PLATAFORMAS) return JSON.parse(process.env.MK_PLATAFORMAS);
  } catch (_) {}
  return { netflix: 'netflix', disney: 'disney', max: 'max' };
}


function mapaFlavinho() {
  try {
    if (process.env.FLAVINHO_TIPOS) return JSON.parse(process.env.FLAVINHO_TIPOS);
  } catch (_) {}
  return { netflix: 'netflix', disney: 'disney', max: 'hbo' };
}

// A resposta do Flavinho ainda não foi vista: aceita as formas mais comuns.
// 1) campo de código pronto (code/codigo/otp) | 2) lista (codes/results/data) | 3) e-mail em HTML (html/body/content)
async function acharCodigo(data, extrair, plataforma, nivel = 0) {
  if (data == null || nivel > 4) return null;
  if (typeof data === 'string') {
    if (/<[a-z][\s\S]*>/i.test(data) && data.length > 15) {
      const c = await extrair(data, plataforma);
      return c && CODIGO_OK.test(String(c)) ? String(c) : null;
    }
    return null;
  }
  if (typeof data === 'number') return null;
  if (Array.isArray(data)) {
    for (const it of data) {
      const c = await acharCodigo(it, extrair, plataforma, nivel + 1);
      if (c) return c;
    }
    return null;
  }
  if (typeof data === 'object') {
    for (const k of ['code', 'codigo', 'otp', 'verificationCode']) {
      if (data[k] != null) {
        const c = String(data[k]).replace(/\s+/g, '');
        if (CODIGO_OK.test(c)) return c;
      }
    }
    for (const k of ['codes', 'results', 'data', 'emails', 'messages', 'html', 'body', 'content', 'text']) {
      if (data[k] != null) {
        const c = await acharCodigo(data[k], extrair, plataforma, nivel + 1);
        if (c) return c;
      }
    }
  }
  return null;
}

const parceiros = [
  {
    nome: 'MK Digital',
    // nome nosso -> valor do <select> no MK (o MK não atende Prime Video)
    plataformas: mapaMK(),
    ativo: () => !!process.env.MK_URL,
    // O MK recebe POST /buscar { email, plataforma } e devolve { success, html } com o e-mail inteiro.
    // Aqui o servidor extrai o código desse HTML com as MESMAS funções que já leem a sua caixa de e-mail.
    async buscar({ email, plataforma, plataformaNossa, extrair }) {
      const url = process.env.MK_URL.replace(/\/$/, '') + (process.env.MK_BUSCAR_PATH || '/buscar');
      const resp = await axios.post(
        url,
        { email, plataforma },
        { timeout: TIMEOUT, validateStatus: () => true }
      );
      if (resp.status < 200 || resp.status >= 300) return null;
      const d = resp.data;
      if (!d || d.success !== true || typeof d.html !== 'string' || !d.html) return null;
      const code = await extrair(d.html, plataformaNossa);
      return code && CODIGO_OK.test(String(code)) ? String(code) : null;
    },
  },
  {
    nome: 'Flavinho Códigos',
    // nome nosso -> valor de "type" no Flavinho. "max" -> "hbo" é um PALPITE (o site fala em "HBO"): confirme.
    plataformas: mapaFlavinho(),
    ativo: () => !!(process.env.FLAVINHO_API && process.env.FLAVINHO_APIKEY),
    // POST {API}/fetch-email-codes  { filterEmail, type, timestamp }  com o cabeçalho apikey (chave pública).
    // O pedido que o site faz não manda o token do login, então aqui não é preciso usuário/senha.
    async buscar({ email, plataforma, plataformaNossa, extrair }) {
      const url = process.env.FLAVINHO_API.replace(/\/$/, '') + '/fetch-email-codes';
      const resp = await axios.post(
        url,
        { filterEmail: email, type: plataforma, timestamp: Date.now() },
        {
          timeout: TIMEOUT,
          headers: { apikey: process.env.FLAVINHO_APIKEY, 'Content-Type': 'application/json' },
          validateStatus: () => true,
        }
      );
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error('HTTP ' + resp.status);
      }
      const d = resp.data;
      if (d && d.success === false) return null;
      // Formato real do Flavinho: { success, emails: [ { code, date, emailType, ... } ] }.
      // Usa o código do e-mail MAIS RECENTE; só olha o campo "code" (o resto da resposta é ignorado).
      if (d && Array.isArray(d.emails)) {
        const lista = d.emails
          .filter((e) => e && e.code != null)
          .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
        for (const e of lista) {
          const c = String(e.code).replace(/\s+/g, '');
          if (CODIGO_OK.test(c)) return c;
        }
        return null;
      }
      return acharCodigo(d, extrair, plataformaNossa);
    },
  },
];

// Tenta um parceiro por vez, na ordem. Erro em um não derruba a busca: passa para o próximo.
// extrair(html, plataforma) -> código ou null (vem do server.js)
async function buscarNosParceiros(email, plataforma, extrair) {
  for (const p of parceiros) {
    if (!p.ativo()) continue;
    const alvo = p.plataformas[plataforma];
    if (!alvo) continue;
    try {
      const code = await p.buscar({ email, plataforma: alvo, plataformaNossa: plataforma, extrair });
      if (code) {
        console.log(`[fallback] código encontrado em ${p.nome} (${plataforma})`);
        return { code, origem: p.nome };
      }
      console.log(`[fallback] ${p.nome}: sem código (${plataforma})`);
    } catch (e) {
      console.error(`[fallback] ${p.nome} falhou:`, e.message);
    }
  }
  return null;
}

module.exports = { buscarNosParceiros, parceiros };
