const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const Logger = require('./Logger');

class ClaudeRequest {
  constructor(config) {
    this.config = config;
    
    // Claude API constants
    this.API_URL = 'https://api.anthropic.com/v1/messages?beta=true';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
    this.STRIP_TTL = true;
    this.REFRESH_STRATEGY = 'command'; // 'command' (default) or 'oauth'
    
    this.currentToken = null;
    this.presetCache = new Map();
    this.TIMEOUT_MS = 10000;
    this.CLAUDE_TIMEOUT_MS = 120000; // 2 minutes for Claude responses
    
    this.refreshToken = this.REFRESH_STRATEGY === 'oauth' 
      ? this.refreshTokenWithOAuth.bind(this)
      : this.refreshTokenWithClaudeCode.bind(this);
    
    this.stripTtlFromCacheControl = this.STRIP_TTL 
      ? this.stripTtlFromCacheControlImpl.bind(this)
      : (body) => body;
  }

  createTimeout(callback, errorMessage, timeoutMs = this.TIMEOUT_MS) {
    let isResolved = false;
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        callback(new Error(errorMessage));
      }
    }, timeoutMs);
    
    return {
      clear: () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
        }
      },
      isResolved: () => isResolved
    };
  }

  stripTtlFromCacheControlImpl(body) {
    if (!this.STRIP_TTL) return body;
    if (!body || typeof body !== 'object') return body;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;
      
      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            Logger.debug('Removed ttl from cache_control');
          }
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }

    return body;
  }

  async getAuthToken() {
    if (this.currentToken) {
      return this.currentToken;
    }

    return await this.loadOrRefreshToken();
  }

  async loadOrRefreshToken() {
    try {
      this.currentToken = this.loadTokenFromCredentials();
      return this.currentToken;
    } catch (error) {
      Logger.debug('No valid token in credentials, trying refresh...');
    }

    this.currentToken = await this.refreshToken();
    return this.currentToken;
  }

  loadCredentialsData() {
    let credentialsPath, credentialsData;
    
    if (process.platform === 'win32') {
      credentialsData = execSync('wsl cat ~/.claude/.credentials.json', { 
        encoding: 'utf8', 
        timeout: this.TIMEOUT_MS
      });
    } else {
      credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      credentialsData = fs.readFileSync(credentialsPath, 'utf8');
    }

    return JSON.parse(credentialsData);
  }

  async saveTokenToCredentials(credentials) {
    const credentialsJson = JSON.stringify(credentials);
    
    if (process.platform === 'win32') {
      const tempFile = '/tmp/credentials.json';
      execSync(`echo '${credentialsJson.replace(/'/g, "'\\''")}' | wsl tee ~/.claude/.credentials.json > /dev/null`, {
        timeout: this.TIMEOUT_MS
      });
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.writeFileSync(credentialsPath, credentialsJson, 'utf8');
    }
  }

  loadTokenFromCredentials() {
    try {
      const credentials = this.loadCredentialsData();
      
      if (!credentials.claudeAiOauth?.accessToken) {
        throw new Error('No access token found');
      }

      const oauth = credentials.claudeAiOauth;
      
      if (oauth.expiresAt && Date.now() >= oauth.expiresAt) {
        throw new Error('Token expired');
      }

      if (oauth.expiresAt && (oauth.expiresAt - Date.now()) < 10000) {
        throw new Error('Token expires within 10 seconds');
      }

      Logger.debug('Loaded token from credentials');
      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      throw new Error(`Failed to load credentials: ${error.message}`);
    }
  }

  async refreshTokenWithOAuth() {
    try {
      const credentials = this.loadCredentialsData();
      const refreshToken = credentials.claudeAiOauth?.refreshToken;
      
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'axios/1.8.4'
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
      });

      if (!response.ok) {
        throw new Error(`OAuth refresh failed: ${response.status} ${response.statusText}`);
      }

      const tokenData = await response.json();
      
      // Update credentials with new tokens
      const newCredentials = {
        ...credentials,
        claudeAiOauth: {
          ...credentials.claudeAiOauth,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + (tokenData.expires_in * 1000)
        }
      };

      await this.saveTokenToCredentials(newCredentials);
      
      Logger.info('Successfully refreshed token via OAuth');
      return `Bearer ${tokenData.access_token}`;
    } catch (error) {
      throw new Error(`OAuth token refresh failed: ${error.message}`);
    }
  }

  async refreshTokenWithClaudeCode() {
    return new Promise((resolve, reject) => {
      let command, args;
      
      if (process.platform === 'win32') {
        command = 'wsl';
        args = ['-i', 'claude', '-p', 'Hi.', '--system-prompt', 'This is a test, respond in one word.'];
      } else {
        command = 'claude';
        args = ['-p', 'Hi.', '--system-prompt', 'This is a test, respond in one word.'];
      }
      
      const claude = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      const timeoutHandler = this.createTimeout((error) => {
        claude.kill('SIGTERM');
        reject(error);
      }, `Claude command timed out after ${this.TIMEOUT_MS}ms`);

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        if (!timeoutHandler.isResolved()) {
          timeoutHandler.clear();
          
          if (code === 0) {
            try {
              const token = this.loadTokenFromCredentials();
              if (token) {
                Logger.info('Successfully refreshed token via claude command');
                resolve(token);
              } else {
                reject(new Error('No valid token found after claude command'));
              }
            } catch (error) {
              reject(new Error(`Failed to read credentials after claude command: ${error.message}`));
            }
          } else {
            reject(new Error(`Claude command failed (code ${code}): ${stderr}`));
          }
        }
      });

      claude.on('error', (error) => {
        if (!timeoutHandler.isResolved()) {
          timeoutHandler.clear();
          reject(new Error(`Failed to run claude command: ${error.message}`));
        }
      });
    });
  }

  getHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': this.VERSION,
      'User-Agent': 'claude-code-proxy/1.0.0'
    };

    if (this.BETA_HEADER) {
      headers['anthropic-beta'] = this.BETA_HEADER;
    }

    return headers;
  }

  processRequestBody(body, presetName = null) {
    if (!body) return body;

    // Strip TTL from cache_control objects first
    body = this.stripTtlFromCacheControl(body);

    const systemPrompt = {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    };

    if (body.system) {
      if (Array.isArray(body.system)) {
        body.system.unshift(systemPrompt);
      } else {
        throw new Error('system field must be an array');
      }
    } else {
      body.system = [systemPrompt];
    }

    if (presetName) {
      this.applyPreset(body, presetName);
    }

    return body;
  }

  loadPreset(presetName) {
    if (this.presetCache.has(presetName)) {
      return this.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      this.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.warn(`Failed to load preset ${presetName}: ${error.message}`);
      this.presetCache.set(presetName, null);
      return null;
    }
  }

  applyPreset(body, presetName) {
    const preset = this.loadPreset(presetName);
    if (!preset) {
      Logger.warn(`Unknown preset: ${presetName}`);
      return;
    }

    if (preset.system) {
      const presetSystemPrompt = {
        type: 'text',
        text: preset.system
      };
      body.system.push(presetSystemPrompt);
    }

    // Use suffixEt only when thinking is enabled, otherwise use regular suffix
    const hasThinking = body.thinking && body.thinking.type === 'enabled';
    const suffix = hasThinking ? preset.suffixEt : preset.suffix;
    
    if (suffix && body.messages && body.messages.length > 0) {
      const lastUserIndex = body.messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        const suffixMsg = {
          role: 'user',
          content: [{ type: 'text', text: suffix }]
        };
        body.messages.splice(lastUserIndex + 1, 0, suffixMsg);
      }
    }

    Logger.debug(`Applied preset: ${presetName}`);
  }

  async makeRequest(body, presetName = null) {
    const token = await this.getAuthToken();
    const headers = this.getHeaders(token);
    const processedBody = this.processRequestBody(body, presetName);

    Logger.debug('Outgoing headers to Claude:', JSON.stringify(headers, null, 2));
    Logger.debug(`Final request to Claude (${JSON.stringify(processedBody).length} bytes):`, JSON.stringify(processedBody, null, 2));

    const response = await fetch(this.API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(processedBody),
      signal: AbortSignal.timeout(this.CLAUDE_TIMEOUT_MS)
    });

    return response;
  }

  async handleResponse(res, body, presetName = null) {
    try {
      const claudeResponse = await this.makeRequest(body, presetName);
      
      // Handle 401 by checking for refreshed credentials and retrying once
      if (claudeResponse.status === 401) {
        Logger.warn('Got 401, clearing token and checking for refresh...');
        this.currentToken = null;
        
        try {
          await this.loadOrRefreshToken();
          const retryResponse = await this.makeRequest(body, presetName);
          res.statusCode = retryResponse.status;
          Logger.debug(`Claude API retry status: ${retryResponse.status}`);
          Logger.debug('Claude retry response headers:', JSON.stringify([...retryResponse.headers.entries()], null, 2));
          retryResponse.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          await this.streamResponse(res, retryResponse);
          return;
        } catch (error) {
          Logger.error('Token refresh failed, passing 401 to client');
        }
      }
      
      res.statusCode = claudeResponse.status;
      Logger.debug(`Claude API status: ${claudeResponse.status}`);
      
      if (claudeResponse.status >= 400) {
        Logger.error(`Claude API error: ${claudeResponse.status} ${claudeResponse.statusText}`);
      }
      
      Logger.debug('Claude response headers:', JSON.stringify([...claudeResponse.headers.entries()], null, 2));
      claudeResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      
      await this.streamResponse(res, claudeResponse);
      
    } catch (error) {
      Logger.error('Claude request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  async streamResponse(res, claudeResponse) {
    const extractClaudeText = (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                return { text: data.delta.text };
              }
              if (data.delta?.type === 'thinking_delta') {
                return { thinking: data.delta.thinking };
              }
            }
          }
        }
      } catch (e) {
      }
      return null;
    };

    const contentType = claudeResponse.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      Logger.debug('Outgoing response headers to client:', JSON.stringify(res.getHeaders(), null, 2));
      const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);
      
      const reader = claudeResponse.body.getReader();
      
      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        reader.cancel();
      });
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = Buffer.from(value);
          debugStream.write(chunk);
          res.write(chunk);
        }
        
        debugStream.end();
        res.end();
        Logger.debug('\n');
        Logger.debug('Streaming response sent back to client');
      } catch (err) {
        Logger.debug('Claude response stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      }
    } else {
      res.removeHeader('content-encoding');
      
      try {
        const responseData = await claudeResponse.text();
        try {
          const jsonData = JSON.parse(responseData);
          res.setHeader('Content-Type', 'application/json');
          Logger.debug('Outgoing response headers to client:', JSON.stringify(res.getHeaders(), null, 2));
          res.end(JSON.stringify(jsonData));
          Logger.debug('Non-streaming response sent back to client');
        } catch (e) {
          res.end(responseData);
          Logger.debug('Raw response sent back to client');
        }
      } catch (err) {
        Logger.debug('Failed to read response body:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read response' }));
      }
    }
  }
}

module.exports = ClaudeRequest;
