/**
 * ProjectRegistry — lê projetos do Google Sheets via API pública (read-only).
 *
 * Formato esperado da planilha (aba "Projetos"):
 * Coluna A: chat_id      — ID do chat Telegram do cliente
 * Coluna B: name         — Nome do projeto (ex: "Casa Lealdo")
 * Coluna C: hm_host      — IP ou URL externa do Home Manager
 * Coluna D: hm_http_port — Porta HTTP (padrão 9090)
 * Coluna E: hm_tcp_port  — Porta TCP (padrão 18080)
 * Coluna F: hm_key       — Código de segurança HTTP
 * Coluna G: devices_json — JSON com dispositivos: [{"id":101,"name":"Sala","type":"dimmer","location":"Sala"}]
 * Coluna H: active       — TRUE/FALSE para ativar/desativar o cliente
 *
 * A primeira linha deve ser o cabeçalho (será ignorada).
 */
export class ProjectRegistry {
  constructor(sheetsId, apiKey) {
    this.sheetsId = sheetsId;
    this.apiKey   = apiKey;
    this.cache    = new Map();      // chat_id (string) → project
    this.lastLoad = 0;
    this.TTL      = 5 * 60 * 1000; // recarrega a cada 5 min automaticamente
  }

  async refresh() {
    const range  = encodeURIComponent('Projetos!A2:H200');
    const url    = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetsId}/values/${range}?key=${this.apiKey}`;

    const res  = await fetch(url);
    const data = await res.json();

    if (!data.values) {
      console.warn('[Registry] Planilha vazia ou sem acesso.');
      return;
    }

    this.cache.clear();

    for (const row of data.values) {
      const [chat_id, name, hm_host, hm_http_port, hm_tcp_port, hm_key, devices_json, active] = row;
      if (!chat_id || !name || !hm_host) continue;
      if (active && active.toUpperCase() === 'FALSE') continue;

      let devices = [];
      try { devices = JSON.parse(devices_json || '[]'); } catch { /* ignora */ }

      this.cache.set(String(chat_id).trim(), {
        chat_id: String(chat_id).trim(),
        name: name.trim(),
        hm_host: hm_host.trim(),
        hm_http_port: Number(hm_http_port) || 9090,
        hm_tcp_port:  Number(hm_tcp_port)  || 18080,
        hm_key: (hm_key || '').trim(),
        devices,
      });
    }

    this.lastLoad = Date.now();
    console.log(`[Registry] ${this.cache.size} projeto(s) carregado(s)`);
  }

  async getProject(chat_id) {
    // Auto-refresh se cache expirou
    if (Date.now() - this.lastLoad > this.TTL) {
      await this.refresh().catch(console.error);
    }
    return this.cache.get(String(chat_id)) || null;
  }

  count() {
    return this.cache.size;
  }

  // Lista todos (para admin)
  all() {
    return Array.from(this.cache.values());
  }
}
