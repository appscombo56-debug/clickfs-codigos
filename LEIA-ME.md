# ClickFS Códigos — Guia de Instalação

## O que foi criado

- `server.js` → Backend Node.js que lê os e-mails via IMAP
- `public/index.html` → Site dark/tech para os clientes
- `.env.example` → Configuração de credenciais
- `package.json` → Dependências

---

## Como hospedar na Hostinger

### Passo 1 — Comprar hospedagem
Acesse hostinger.com.br e compre um plano com suporte a **Node.js** (plano Business ou superior).

### Passo 2 — Fazer upload dos arquivos
No painel da Hostinger (hPanel):
1. Vá em **Hospedagem → Gerenciar**
2. Abra o **Gerenciador de Arquivos**
3. Suba todos os arquivos para a pasta `public_html` (ou a raiz do seu domínio)

### Passo 3 — Configurar as variáveis de ambiente
1. Renomeie `.env.example` para `.env`
2. Abra o arquivo `.env` e preencha:
   ```
   IMAP_USER=clientebom@clicknoel.org
   IMAP_PASS=SUA_SENHA_DO_EMAIL_AQUI
   IMAP_HOST=imail.hostinger.com
   IMAP_PORT=993
   PORT=3000
   ```

### Passo 4 — Instalar dependências
Via SSH ou terminal da Hostinger:
```bash
npm install
```

### Passo 5 — Iniciar o servidor
```bash
npm start
```
Para manter rodando permanentemente, use o **PM2**:
```bash
npm install -g pm2
pm2 start server.js --name clickfs
pm2 save
pm2 startup
```

---

## Como funciona

1. O cliente acessa o site, digita o e-mail e seleciona a plataforma
2. O servidor conecta via IMAP na sua caixa `clientebom@clicknoel.org`
3. Busca e-mails das últimas 24h enviados para aquele e-mail
4. Extrai o código automaticamente e exibe na tela

---

## Testar localmente (no seu PC)

```bash
# Instalar Node.js em nodejs.org se não tiver

# Na pasta do projeto:
npm install

# Criar o .env com sua senha
cp .env.example .env
# Edite o .env com sua senha

# Iniciar
npm start

# Acesse: http://localhost:3000
```

---

## Suporte IMAP Hostinger
- Host: `imail.hostinger.com`
- Porta: `993` (SSL/TLS)
- Usuário: seu e-mail completo
- Senha: senha do e-mail (não do painel Hostinger)
