import net from 'net';
import { EventEmitter } from 'events';

/**
 * HMClient — cliente dual (HTTP + TCP) para o Home Manager (SVLAN)
 *
 * HTTP: GET http://[host]:[port]/HomeWeb/command.do?id=[ID]&valor=[VALOR]&key=[KEY]
 * TCP:  porta 18080, ASCII, #ID=123,VALOR=ON\n  |  keepalive: #ALV\n → #ACK\n
 */
export class HMClient extends EventEmitter {
  constructor({ host, httpPort = 9090, tcpPort = 18080, key = '', useTcp = false }) {
    super();
    this.host = host;
    this.httpPort = httpPort;
    this.tcpPort = tcpPort;
    this.key = key;
    this.useTcp = useTcp;

    // Estado TCP
    this._socket = null;
    this._tcpConnected = false;
    this._tcpBuffer = '';
    this._pendingCallbacks = new Map(); // id → resolve/reject
    this._aliveInterval = null;
    this._reconnectTimer = null;
    this._deviceCache = {}; // id → status
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  _buildUrl(id, valor) {
    const base = this.host.startsWith('http') ? this.host : `http://${this.host}`;
    const url = `${base}:${this.httpPort}/HomeWeb/command.do?id=${id}&valor=${encodeURIComponent(valor)}`;
    return this.key ? `${url}&key=${this.key}` : url;
  }

  async _httpCommand(id, valor) {
    const url = this._buildUrl(id, valor);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const text = await res.text();
      clearTimeout(timeout);
      return text.trim();
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`HTTP error: ${err.message}`);
    }
  }

  async _httpGetAllStatus() {
    return this._httpCommand('ALL', '?');
  }

  async _httpListDevices() {
    return this._httpCommand('ALL', 'LIST');
  }

  // ─── TCP ───────────────────────────────────────────────────────────────────

  async ensureConnected() {
    if (!this.useTcp) return;
    if (this._tcpConnected) return;
    return this._tcpConnect();
  }

  _tcpConnect() {
    return new Promise((resolve, reject) => {
      if (this._socket) {
        this._socket.destroy();
        this._socket = null;
      }

      const socket = new net.Socket();
      this._socket = socket;

      const onConnect = () => {
        this._tcpConnected = true;
        this._startKeepalive();
        this.emit('connected');
        resolve();
      };

      const onError = (err) => {
        this._tcpConnected = false;
        this.emit('disconnected', err);
        this._scheduleReconnect();
        reject(err);
      };

      socket.connect(this.tcpPort, this.host.replace(/^https?:\/\//, ''), onConnect);
      socket.on('error', onError);
      socket.on('close', () => {
        this._tcpConnected = false;
        this.emit('disconnected');
        this._scheduleReconnect();
      });

      socket.on('data', (chunk) => {
        this._tcpBuffer += chunk.toString('ascii');
        this._processTcpBuffer();
      });
    });
  }

  _processTcpBuffer() {
    const lines = this._tcpBuffer.split('\n');
    this._tcpBuffer = lines.pop(); // último pode ser incompleto

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Keepalive ACK
      if (line === '#ACK') continue;

      // Status feedback: #ID=123,STATUS=ON
      const match = line.match(/^#ID=(\d+),STATUS=(.+)$/);
      if (match) {
        const id = Number(match[1]);
        const status = match[2];
        this._deviceCache[id] = status;
        this.emit('status', { id, status });

        // Resolve callback pendente
        const cb = this._pendingCallbacks.get(id);
        if (cb) {
          cb.resolve(status);
          this._pendingCallbacks.delete(id);
        }
        continue;
      }

      // Resposta de LIST: #ID=123,NAME=Sala,TYPE=LIGHT,...
      const listMatch = line.match(/^#ID=(\d+),(.+)$/);
      if (listMatch) {
        this.emit('device_info', { id: Number(listMatch[1]), raw: listMatch[2] });
      }
    }
  }

  _startKeepalive() {
    clearInterval(this._aliveInterval);
    this._aliveInterval = setInterval(() => {
      if (this._tcpConnected && this._socket) {
        this._socket.write('#ALV\n');
      }
    }, 55000); // a cada 55s (< 1 min)
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      console.log('[HM] Tentando reconectar TCP...');
      this._tcpConnect().catch(() => {});
    }, 5000);
  }

  _tcpSend(id, valor) {
    return new Promise((resolve, reject) => {
      if (!this._tcpConnected || !this._socket) {
        reject(new Error('TCP não conectado'));
        return;
      }

      const timeout = setTimeout(() => {
        this._pendingCallbacks.delete(id);
        reject(new Error(`Timeout aguardando resposta do dispositivo ${id}`));
      }, 5000);

      if (valor === '?') {
        // Para consultas, espera o STATUS de volta
        this._pendingCallbacks.set(id, {
          resolve: (status) => { clearTimeout(timeout); resolve(status); },
          reject: (err) => { clearTimeout(timeout); reject(err); },
        });
      } else {
        // Para comandos, não há retorno de status — resolve imediatamente
        clearTimeout(timeout);
        resolve('OK');
      }

      this._socket.write(`#ID=${id},VALOR=${valor}\n`);
    });
  }

  async _tcpGetAllStatus() {
    return new Promise((resolve, reject) => {
      if (!this._tcpConnected || !this._socket) {
        reject(new Error('TCP não conectado'));
        return;
      }

      const collected = [];
      const timeout = setTimeout(() => resolve(collected), 3000);

      const handler = (data) => collected.push(data);
      this.on('status', handler);

      this._socket.write('#ID=ALL,VALOR=?\n');

      setTimeout(() => {
        this.off('status', handler);
        clearTimeout(timeout);
        resolve(collected);
      }, 2500);
    });
  }

  async _tcpListDevices() {
    return new Promise((resolve, reject) => {
      if (!this._tcpConnected || !this._socket) {
        reject(new Error('TCP não conectado'));
        return;
      }

      const collected = [];
      const handler = (data) => collected.push(data);
      this.on('device_info', handler);

      this._socket.write('#ID=ALL,VALOR=LIST\n');

      setTimeout(() => {
        this.off('device_info', handler);
        resolve(collected);
      }, 2500);
    });
  }

  // ─── API Pública ───────────────────────────────────────────────────────────

  async sendCommand(id, valor) {
    if (this.useTcp) {
      await this.ensureConnected();
      return this._tcpSend(id, valor);
    }
    return this._httpCommand(id, valor);
  }

  async getAllStatus() {
    if (this.useTcp) {
      await this.ensureConnected();
      const raw = await this._tcpGetAllStatus();
      return raw;
    }
    const text = await this._httpGetAllStatus();
    return this._parseStatusResponse(text);
  }

  async listDevices() {
    if (this.useTcp) {
      await this.ensureConnected();
      return this._tcpListDevices();
    }
    const text = await this._httpListDevices();
    return this._parseListResponse(text);
  }

  // ─── Parsers ───────────────────────────────────────────────────────────────

  _parseStatusResponse(text) {
    const devices = [];
    // Formato HTTP: ID:123|STATUS:ON ID:124|STATUS:OFF
    for (const token of text.split(/\s+/)) {
      const m = token.match(/^ID:(\d+)\|STATUS:(.+)$/);
      if (m) devices.push({ id: Number(m[1]), status: m[2] });
    }
    if (devices.length) return devices;
    // Formato TCP: #ID=123,STATUS=ON
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^#?ID=(\d+),STATUS=(.+)$/);
      if (m) devices.push({ id: Number(m[1]), status: m[2] });
    }
    return devices;
  }

  _parseListResponse(text) {
    const devices = [];
    // Formato HTTP: ID:123|NAME:Sala|TYPE:LIGHT
    for (const token of text.split(/\s+/)) {
      if (!token.startsWith('ID:')) continue;
      const props = {};
      for (const part of token.split('|')) {
        const idx = part.indexOf(':');
        if (idx > -1) props[part.slice(0,idx).toLowerCase()] = part.slice(idx+1);
      }
      if (props.id) { props.id = Number(props.id); devices.push(props); }
    }
    if (devices.length) return devices;
    // Formato TCP: #ID=123,NAME=Sala,...
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^#?ID=(\d+),(.+)$/);
      if (m) {
        const props = { id: Number(m[1]) };
        for (const part of m[2].split(',')) {
          const [k, v] = part.split('=');
          if (k && v) props[k.toLowerCase()] = v;
        }
        devices.push(props);
      }
    }
    return devices;
  }

  destroy() {
    clearInterval(this._aliveInterval);
    clearTimeout(this._reconnectTimer);
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
  }
}
