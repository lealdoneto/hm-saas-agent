/**
 * agent-tools.js — tools do Claude para o Home Manager
 * Separado do server para facilitar testes e manutenção.
 */

export function buildTools() {
  return [
    {
      name: 'send_command',
      description: `Envia um comando para um dispositivo do Home Manager.
Valores por tipo:
- Liga/Desliga: ON | OFF | INV | ?
- Dimmer: 0–100 (múltiplos de 5) | INV | ?
- Cortina: 0–100 | INV | STP | ?
- Cenário: X
- Climatização/Termostato: 17–28 | OFF | Swing | ?
- Multimídia: OFF | IPT-[ID] | VOL-50 | ?
- RGB: 0_r | 10_b | 50_g | 100_w | ?
Use ? para consultar o estado atual.`,
      input_schema: {
        type: 'object',
        properties: {
          id:    { type: 'number', description: 'ID numérico do dispositivo' },
          valor: { type: 'string', description: 'Valor do comando' },
          label: { type: 'string', description: 'Nome legível do dispositivo (para confirmação)' },
        },
        required: ['id', 'valor'],
      },
    },
    {
      name: 'send_command_batch',
      description: 'Envia múltiplos comandos simultaneamente. Use para "apagar tudo", "modo cinema", "boa noite" etc.',
      input_schema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:    { type: 'number' },
                valor: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'valor'],
            },
          },
          description: {
            type: 'string',
            description: 'Descrição da ação em conjunto (ex: "Modo cinema ativado")',
          },
        },
        required: ['commands'],
      },
    },
    {
      name: 'get_all_status',
      description: 'Retorna o status de todos os dispositivos. Use antes de responder sobre o estado da casa.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_devices',
      description: 'Lista todos os dispositivos com IDs e tipos. Use quando o usuário perguntar o que existe.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ];
}

export async function executeTool(toolName, input, hm, project) {
  try {
    switch (toolName) {
      case 'send_command': {
        const result = await hm.sendCommand(input.id, input.valor);
        return {
          ok: true,
          id: input.id,
          valor: input.valor,
          label: input.label || `Dispositivo ${input.id}`,
          result,
        };
      }

      case 'send_command_batch': {
        const results = await Promise.allSettled(
          input.commands.map(c => hm.sendCommand(c.id, c.valor))
        );
        return {
          ok: true,
          description: input.description,
          summary: results.map((r, i) => ({
            id:    input.commands[i].id,
            label: input.commands[i].label || `Dispositivo ${input.commands[i].id}`,
            valor: input.commands[i].valor,
            ok:    r.status === 'fulfilled',
          })),
        };
      }

      case 'get_all_status': {
        const devices = await hm.getAllStatus();
        // Enriquece com nomes do projeto se disponível
        if (project.devices?.length) {
          const nameMap = Object.fromEntries(project.devices.map(d => [String(d.id), d]));
          return {
            ok: true,
            devices: devices.map(d => ({
              ...d,
              name:     nameMap[String(d.id)]?.name     || `ID ${d.id}`,
              location: nameMap[String(d.id)]?.location || '',
            })),
          };
        }
        return { ok: true, devices };
      }

      case 'list_devices': {
        // Usa lista da planilha se disponível, senão consulta o HM
        if (project.devices?.length) {
          return { ok: true, source: 'registry', devices: project.devices };
        }
        const devices = await hm.listDevices();
        return { ok: true, source: 'hm', devices };
      }

      default:
        return { ok: false, error: `Tool desconhecida: ${toolName}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
