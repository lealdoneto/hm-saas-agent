# HM SaaS Agent — Automação Residencial via Telegram

Agente IA multi-projeto para Home Manager (SVLAN). Um único backend atende N clientes, cada um com seu próprio chat Telegram isolado e seu próprio servidor Home Manager.

---

## Arquitetura

```
Cliente Telegram A ──┐
Cliente Telegram B ──┤── Bot Telegram ── Agente Claude ── HM Client ──┬── HM Casa A
Cliente Telegram C ──┘         ↕                                      ├── HM Casa B
                         Google Sheets                                 └── HM Casa C
                      (banco de projetos)
```

---

## Pré-requisitos

### 1. Criar o Bot no Telegram
1. Acesse [@BotFather](https://t.me/BotFather) no Telegram
2. `/newbot` → escolha um nome e username
3. Copie o **token** (ex: `7123456789:AAF...`)
4. Configure os comandos do bot:
```
/setcommands → selecione seu bot → cole:
start - Iniciar o assistente
status - Ver status de todos os dispositivos
limpar - Apagar histórico da conversa
```

### 2. Configurar o Google Sheets

Crie uma planilha com aba chamada **"Projetos"** e o seguinte cabeçalho na linha 1:

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| chat_id | name | hm_host | hm_http_port | hm_tcp_port | hm_key | devices_json | active |

**Como preencher:**

- `chat_id`: ID do chat Telegram do cliente. Para descobrir, peça ao cliente para enviar uma mensagem para [@userinfobot](https://t.me/userinfobot)
- `name`: Nome do projeto (ex: `Casa Silva`)
- `hm_host`: IP ou URL externa do HM (ex: `192.168.1.100` ou `minhaurl.ddns.net`)
- `hm_http_port`: Porta HTTP do HM (padrão: `9090`)
- `hm_tcp_port`: Porta TCP do HM (padrão: `18080`)
- `hm_key`: Código de segurança HTTP configurado no HM
- `devices_json`: Lista de dispositivos em JSON (opcional, melhora respostas do agente):
```json
[
  {"id": 101, "name": "Luz principal", "type": "dimmer", "location": "Sala"},
  {"id": 102, "name": "Cortina", "type": "cortina", "location": "Sala"},
  {"id": 201, "name": "Ar condicionado", "type": "climatizacao", "location": "Quarto"},
  {"id": 301, "name": "Modo cinema", "type": "cenario", "location": "Sala"}
]
```
- `active`: `TRUE` para ativar, `FALSE` para desativar o cliente

**Tornar a planilha pública (leitura):**
1. Compartilhar → "Qualquer pessoa com o link" → "Leitor"
2. Ativar a Google Sheets API no Google Cloud Console
3. Criar uma **API Key** (sem restrições ou restrita ao Sheets API)

### 3. Variáveis de ambiente

Crie `.env` ou configure no Railway:

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Telegram
TELEGRAM_TOKEN=7123456789:AAF...
ADMIN_CHAT_ID=123456789        # Seu chat_id pessoal (para /reload)

# Google Sheets
GOOGLE_SHEETS_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms  # ID da URL da planilha
GOOGLE_API_KEY=AIzaSy...
```

---

## Deploy no Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set \
  ANTHROPIC_API_KEY=sk-ant-... \
  TELEGRAM_TOKEN=7123:... \
  ADMIN_CHAT_ID=123456 \
  GOOGLE_SHEETS_ID=1Bxi... \
  GOOGLE_API_KEY=AIza...
```

O bot usa **long polling** — não precisa de webhook nem domínio HTTPS. Funciona em qualquer PaaS.

---

## Fluxo de onboarding de novo cliente

1. **Você** cria uma nova linha na planilha com os dados do projeto
2. **Você** pede ao cliente o `chat_id` (via @userinfobot) e adiciona na coluna A
3. **Você** envia `/reload` no Telegram para o bot (como admin)
4. **Cliente** envia `/start` no chat do bot — pronto

O cache da planilha é atualizado automaticamente a cada 5 minutos, então sem precisar de `/reload` (demora um pouco mais).

---

## Comandos disponíveis para clientes

| Comando | Ação |
|---------|------|
| `/start` | Apresenta o assistente e o projeto vinculado |
| `/status` | Lista o status de todos os dispositivos |
| `/limpar` | Apaga o histórico da conversa |
| Texto livre | Acionado pelo agente Claude |

## Comandos admin (ADMIN_CHAT_ID)

| Comando | Ação |
|---------|------|
| `/reload` | Recarrega projetos da planilha imediatamente |

---

## Exemplos de interação do cliente

```
Cliente: Ligue as luzes da sala no 70%
Bot:     ✅ Luz principal da sala ajustada para 70%.

Cliente: Modo cinema
Bot:     🎬 Modo cinema ativado! Cortinas fechadas, luzes apagadas.

Cliente: Qual a temperatura do ar?
Bot:     ❄️ Ar condicionado do quarto está em 22°C (ligado).

Cliente: Boa noite
Bot:     🌙 Boa noite! Apaguei todas as luzes e fechei as cortinas.
```

---

## Evolução futura (roadmap sugerido)

- **Painel admin web** — visualizar todos os projetos e status em tempo real
- **Agendamentos** — "ligue às 7h todo dia útil"
- **Alertas proativos** — "o sensor detectou movimento às 23h"
- **Multi-idioma** — agente responde no idioma do cliente
- **WhatsApp** via Twilio (requer conta business aprovada)
- **Planos e billing** — limite de mensagens por plano, integração com Stripe
