import Anthropic from '@anthropic-ai/sdk';
import { ProjectRegistry } from './registry.js';
import { HMClient } from './hm-client.js';
import { buildTools, executeTool } from './agent-tools.js';

// ─── Config ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID      = process.env.GOOGLE_SHEETS_ID;
const SHEETS_KEY     = process.env.GOOGLE_API_KEY;        // API key pública (read-only)
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID;         // seu chat_id pessoal

const anthropic  = new Anthropic({ apiKey: ANTHROPIC_KEY });
const registry   = new ProjectRegistry(SHEETS_ID, SHEETS_KEY);

// Pool de clientes HM: { chat_id → HMClient }
const hmPool = new Map();

// Histórico de sessão por chat_id (em memória — reinicia com deploy)
const sessions = new Map();

// ─── Telegram API helpers ──────────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function tgApi(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgApi('sendMessage', { chat_id, text, parse_mode: 'Markdown', ...extra });
}

async function sendTyping(chat_id) {
  return tgApi('sendChatAction', { chat_id, action: 'typing' });
}

// ─── Resolve projeto pelo chat_id ──────────────────────────────────────────
async function resolveProject(chat_id) {
  const project = await registry.getProject(String(chat_id));
  if (!project) return null;

  // Garante cliente HM no pool
  if (!hmPool.has(chat_id)) {
    hmPool.set(chat_id, new HMClient({
      host:     project.hm_host,
      httpPort: project.hm_http_port || 9090,
      tcpPort:  project.hm_tcp_port  || 18080,
      key:      project.hm_key || '',
      useTcp:   false,
    }));
  }

  return { project, hm: hmPool.get(chat_id) };
}

// ─── Agentic loop ──────────────────────────────────────────────────────────
async function runAgent(chat_id, project, hm, userMessage) {
  const history = sessions.get(chat_id) || [];
  history.push({ role: 'user', content: userMessage });

  const tools = buildTools();
  const systemPrompt = buildSystemPrompt(project);

  let currentMessages = [...history];
  let finalText = '';

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: currentMessages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    for (const b of textBlocks) finalText += b.text;

    if (response.stop_reason === 'end_turn') break;

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (!toolUseBlocks.length) break;

    currentMessages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tu) => {
        const result = await executeTool(tu.name, tu.input, hm, project);
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
      })
    );

    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Mantém últimas 20 mensagens no histórico
  history.push({ role: 'assistant', content: finalText });
  sessions.set(chat_id, history.slice(-20));

  return finalText;
}

function buildSystemPrompt(project) {
  const deviceList = (project.devices || [])
    .map(d => `  ID ${d.id}: ${d.name} (${d.type}) — ${d.location}`)
    .join('\n');

  return `Você é o assistente de automação residencial do projeto "${project.name}".
Responda sempre em português, de forma concisa e amigável.

DISPOSITIVOS DESTE PROJETO:
${deviceList || '  (use list_devices para descobrir)'}

REGRAS:
- Controle apenas os dispositivos listados acima
- Confirme as ações realizadas de forma clara
- Para comandos ambíguos, consulte o status antes de agir
- Para "modo cinema", "boa noite" etc., agrupe as ações relevantes em send_command_batch
- Use ? para consultar status de um dispositivo antes de falar sobre ele
- Nunca mencione IDs técnicos na resposta ao cliente — use os nomes dos ambientes`;
}

// ─── Webhook handler ───────────────────────────────────────────────────────
async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chat_id = msg.chat.id;
  const text    = msg.text.trim();

  // Comandos especiais
  if (text === '/start') {
    const ctx = await resolveProject(chat_id);
    if (!ctx) {
      return sendMessage(chat_id, '❌ Este chat não está vinculado a nenhum projeto. Entre em contato com o suporte.');
    }
    return sendMessage(chat_id,
      `🏠 *${ctx.project.name}*\n\nOlá! Sou seu assistente de automação. O que posso fazer por você?\n\n_Experimente: "Quais luzes estão ligadas?" ou "Ligue o ar da sala"_`
    );
  }

  if (text === '/status') {
    const ctx = await resolveProject(chat_id);
    if (!ctx) return;
    await sendTyping(chat_id);
    try {
      const devices = await ctx.hm.getAllStatus();
      const lines = devices.map(d => `• ${d.id}: ${d.status}`).join('\n');
      return sendMessage(chat_id, `*Status dos dispositivos:*\n\`\`\`\n${lines || 'Sem dados'}\n\`\`\``);
    } catch (e) {
      return sendMessage(chat_id, `❌ Erro ao consultar HM: ${e.message}`);
    }
  }

  if (text === '/limpar') {
    sessions.delete(chat_id);
    return sendMessage(chat_id, '🗑️ Histórico da conversa apagado.');
  }

  // Admin: recarregar planilha
  if (text === '/reload' && String(chat_id) === ADMIN_CHAT_ID) {
    await registry.refresh();
    return sendMessage(chat_id, '✅ Projetos recarregados do Google Sheets.');
  }

  // Mensagem normal → agente
  const ctx = await resolveProject(chat_id);
  if (!ctx) {
    return sendMessage(chat_id, '❌ Projeto não encontrado. Entre em contato com o suporte.');
  }

  await sendTyping(chat_id);

  try {
    const reply = await runAgent(chat_id, ctx.project, ctx.hm, text);
    if (reply) await sendMessage(chat_id, reply);
  } catch (err) {
    console.error(`[${chat_id}] Erro no agente:`, err);
    await sendMessage(chat_id, '⚠️ Ocorreu um erro. Tente novamente em instantes.');
  }
}

// ─── Polling (Railway/Render sem webhook fixo) ─────────────────────────────
let offset = 0;

async function poll() {
  try {
    const data = await tgApi('getUpdates', { offset, timeout: 30, limit: 10 });
    if (data.ok && data.result.length) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch(console.error);
      }
    }
  } catch (err) {
    console.error('[poll] erro:', err.message);
  }
  setTimeout(poll, 1000);
}

// ─── Start ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏠 HM SaaS Agent iniciando...');
  await registry.refresh();
  console.log(`📋 ${registry.count()} projeto(s) carregado(s) do Google Sheets`);
  poll();
  console.log('📡 Telegram polling ativo');
}

main().catch(console.error);
