const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const Logger = require('./Logger');

class ClaudeRequest {
  constructor(config) {
    this.config = config;
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = config.beta_header || '';
    this.currentToken = null;
    this.presetCache = new Map();
  }

  stripTtlFromCacheControl(body) {
    if (!this.config.strip_ttl) return body;
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
      const token = this.loadTokenFromCredentials();
      if (token) {
        this.currentToken = token;
        return token;
      }
    } catch (error) {
      console.log('No valid token in credentials, trying claude command...');
    }

    try {
      const token = await this.refreshTokenWithClaude();
      this.currentToken = token;
      return token;
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  loadTokenFromCredentials() {
    try {
      let credentialsPath, credentialsData;
      
      if (process.platform === 'win32') {
        credentialsData = execSync('wsl cat ~/.claude/.credentials.json', { 
          encoding: 'utf8', 
          timeout: 10000 
        });
      } else {
        credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
        credentialsData = fs.readFileSync(credentialsPath, 'utf8');
      }

      const credentials = JSON.parse(credentialsData);
      
      if (!credentials.claudeAiOauth?.accessToken) {
        throw new Error('No access token found');
      }

      const oauth = credentials.claudeAiOauth;
      
      if (oauth.expiresAt && Date.now() >= oauth.expiresAt) {
        throw new Error('Token expired');
      }

      const token = oauth.accessToken.startsWith('Bearer ') 
        ? oauth.accessToken 
        : `Bearer ${oauth.accessToken}`;

      console.log('Loaded token from credentials');
      return token;
    } catch (error) {
      throw new Error(`Failed to load credentials: ${error.message}`);
    }
  }

  async refreshTokenWithClaude() {
    return new Promise((resolve, reject) => {
      const claude = spawn('claude', ['-p', 'Hi.', '--system-prompt', 'This is a test, respond in one word.'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        if (code === 0) {
          try {
            const token = this.loadTokenFromCredentials();
            if (token) {
              console.log('Successfully refreshed token via claude command');
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
      });

      claude.on('error', (error) => {
        reject(new Error(`Failed to run claude command: ${error.message}`));
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
      console.log(`Failed to load preset ${presetName}: ${error.message}`);
      this.presetCache.set(presetName, null);
      return null;
    }
  }

  applyPreset(body, presetName) {
    const preset = this.loadPreset(presetName);
    if (!preset) {
      console.warn(`Unknown preset: ${presetName}`);
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

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname,
      method: 'POST',
      headers: headers
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        resolve(res);
      });

      req.on('error', (err) => {
        req.destroy();
        reject(err);
      });
      
      req.write(JSON.stringify(processedBody));
      req.end();
    });
  }

  async handleResponse(res, body, presetName = null) {
    try {
      const claudeResponse = await this.makeRequest(body, presetName);
      
      // Handle 401 by checking for refreshed credentials and retrying once
      if (claudeResponse.statusCode === 401) {
        console.log('Got 401, clearing token and checking for refresh...');
        this.currentToken = null;
        
        try {
          await this.loadOrRefreshToken();
          const retryResponse = await this.makeRequest(body, presetName);
          res.statusCode = retryResponse.statusCode;
          Logger.debug(`Claude API retry status: ${retryResponse.statusCode}`);
          Logger.debug('Claude retry response headers:', JSON.stringify(retryResponse.headers, null, 2));
          Object.keys(retryResponse.headers).forEach(key => {
            res.setHeader(key, retryResponse.headers[key]);
          });
          this.streamResponse(res, retryResponse);
          return;
        } catch (error) {
          console.log('Token refresh failed, passing 401 to client');
        }
      }
      
      res.statusCode = claudeResponse.statusCode;
      Logger.debug(`Claude API status: ${claudeResponse.statusCode}`);
      Logger.debug('Claude response headers:', JSON.stringify(claudeResponse.headers, null, 2));
      Object.keys(claudeResponse.headers).forEach(key => {
        res.setHeader(key, claudeResponse.headers[key]);
      });
      
      this.streamResponse(res, claudeResponse);
      
    } catch (error) {
      console.error('Claude request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  streamResponse(res, claudeResponse) {
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

    const contentType = claudeResponse.headers['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      Logger.debug('Outgoing response headers to client:', JSON.stringify(res.getHeaders(), null, 2));
      const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);
      
      claudeResponse.on('error', (err) => {
        Logger.debug('Claude response stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      });
      
      debugStream.on('error', (err) => {
        Logger.debug('Debug stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Stream processing error' }));
        }
      });
      
      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        if (!claudeResponse.destroyed) {
          claudeResponse.destroy();
        }
      });
      
      claudeResponse.pipe(debugStream).pipe(res);
      debugStream.on('end', () => {
        process.stdout.write('\n');
        Logger.debug('Streaming response sent back to client');
      });
    } else {
      res.removeHeader('content-encoding');
      
      let responseData = '';
      claudeResponse.on('data', chunk => {
        responseData += chunk;
      });
      claudeResponse.on('end', () => {
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
      });
    }
  }
}

module.exports = ClaudeRequest;
