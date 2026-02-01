const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');

const STRIP_TTL = true;
const TOKEN_REFRESH_METHOD = 'OAUTH'; // 'OAUTH' or 'CLAUDE_CODE_CLI'

// Load configuration
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = {};

    configData.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const commentIndex = trimmed.indexOf('#');
      const cleanLine = commentIndex !== -1 ? trimmed.substring(0, commentIndex).trim() : trimmed;

      const [key, value] = cleanLine.split('=').map(s => s.trim());
      if (key && value !== undefined) {
        config[key] = value === 'true' ? true : value === 'false' ? false : value;
      }
    });

    return config;
  } catch (error) {
    Logger.warn(`Failed to load config: ${error.message}`);
    return {};
  }
};

const CONFIG = loadConfig();
const FILTER_SAMPLING_PARAMS = CONFIG.filter_sampling_params === true; // Default to false
const FALLBACK_TO_CLAUDE_CODE = CONFIG.fallback_to_claude_code !== false; // Default to true

class ClaudeRequest {
  static cachedToken = null;
  static presetCache = new Map();
  static refreshPromise = null;

  constructor(req = null) {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

    const apiKey = req?.headers?.['x-api-key'];
    if (apiKey && apiKey.includes('sk-ant')) {
      Logger.debug('Using x-api-key as token, replacing cache');
      const token = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
      ClaudeRequest.cachedToken = token;
    }

    this.refreshToken = TOKEN_REFRESH_METHOD === 'OAUTH' ? this.refreshTokenWithOauth : this.refreshTokenWithClaudeCodeCli;
  }

  stripTtlFromCacheControl(body) {
    if (!STRIP_TTL) return body;
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

  filterSamplingParams(body) {
    if (!FILTER_SAMPLING_PARAMS) return body;
    if (!body || typeof body !== 'object') return body;

    const hasTemperature = body.temperature !== undefined;
    const hasTopP = body.top_p !== undefined;

    // If both are present, we need to keep only one
    if (hasTemperature && hasTopP) {
      const tempIsDefault = body.temperature === 1.0;
      const topPIsDefault = body.top_p === 1.0;

      // If both are default, remove top_p (arbitrary choice)
      if (tempIsDefault && topPIsDefault) {
        delete body.top_p;
        Logger.debug('Removed top_p=1.0 from request (both at default, keeping temperature)');
      }
      // If only top_p is default, remove it
      else if (topPIsDefault) {
        delete body.top_p;
        Logger.debug(`Removed top_p=1.0 from request (keeping temperature=${body.temperature})`);
      }
      // If only temperature is default, remove it and keep top_p
      else if (tempIsDefault) {
        delete body.temperature;
        Logger.debug(`Removed temperature=1.0 from request (keeping top_p=${body.top_p})`);
      }
      // If both are non-default, prefer temperature over top_p
      else {
        const topPValue = body.top_p;
        delete body.top_p;
        Logger.debug(`Removed top_p=${topPValue} from request (preferring temperature=${body.temperature})`);
      }
    }
    // If only top_p is present and it's default, remove it
    else if (hasTopP && body.top_p === 1.0) {
      delete body.top_p;
      Logger.debug('Removed top_p=1.0 from request (default value, no temperature specified)');
    }
    // If only temperature is present and it's default, remove it
    else if (hasTemperature && body.temperature === 1.0) {
      delete body.temperature;
      Logger.debug('Removed temperature=1.0 from request (default value, no top_p specified)');
    }

    return body;
  }

  async getAuthToken() {
    if (ClaudeRequest.cachedToken) {
      return ClaudeRequest.cachedToken;
    }

    const token = await this.loadOrRefreshToken();
    ClaudeRequest.cachedToken = token;
    return token;
  }

  async loadOrRefreshToken() {
    try {
      // Try OAuthManager's stored tokens first
      if (OAuthManager.isAuthenticated()) {
        Logger.debug('Using OAuthManager tokens');
        const token = await OAuthManager.getValidAccessToken();
        return `Bearer ${token}`;
      }

      // Fallback to Claude Code credentials if enabled
      if (FALLBACK_TO_CLAUDE_CODE) {
        Logger.debug('Falling back to Claude Code credentials');
        return await this.loadFromClaudeCodeCredentials();
      }

      throw new Error('No authentication tokens found. Please authenticate first.');
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  async loadFromClaudeCodeCredentials() {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const oauth = credentials.claudeAiOauth;

      if (oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000)) {
        Logger.info('Claude Code token expired/expiring, refreshing...');
        return await this.refreshToken();
      }

      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      throw new Error(`Failed to load Claude Code credentials: ${error.message}`);
    }
  }

  loadCredentialsFromFile() {
    if (process.platform === 'win32') {
      // Try native Windows location first
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        return fs.readFileSync(nativePath, 'utf8');
      }
      // Fallback to WSL for users who still have the old setup
      return execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10000 });
    } else {
      // macOS/Linux use the same path convention
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      return fs.readFileSync(credentialsPath, 'utf8');
    }
  }

  writeCredentialsToFile(credentialsJson) {
    if (process.platform === 'win32') {
      // Write to native Windows location if it exists, otherwise use WSL
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        fs.writeFileSync(nativePath, credentialsJson, 'utf8');
      } else {
        execSync(`wsl tee ~/.claude/.credentials.json`, { input: credentialsJson, encoding: 'utf8', timeout: 10000 });
      }
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.writeFileSync(credentialsPath, credentialsJson, 'utf8');
    }
  }


  async refreshTokenWithOauth() {
    // Race condition protection
    if (ClaudeRequest.refreshPromise) {
      return await ClaudeRequest.refreshPromise;
    }
    
    ClaudeRequest.refreshPromise = this._doRefresh();
    try {
      const result = await ClaudeRequest.refreshPromise;
      return result;
    } finally {
      ClaudeRequest.refreshPromise = null;
    }
  }

  async _doRefresh() {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const refreshToken = credentials.claudeAiOauth?.refreshToken;

      const refreshData = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
      };

      const options = {
        hostname: 'console.anthropic.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'claude-code-proxy/1.0.0'
        }
      };

      const response = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseData = '';
          res.on('data', chunk => responseData += chunk);
          res.on('end', () => {
            try {
              const response = JSON.parse(responseData);
              if (res.statusCode === 200) {
                resolve(response);
              } else {
                reject(new Error(`OAuth request failed: ${response.error || responseData}`));
              }
            } catch (error) {
              reject(new Error(`Invalid JSON response: ${responseData}`));
            }
          });
        });

        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('OAuth request timeout'));
        });

        req.on('error', reject);
        req.write(JSON.stringify(refreshData));
        req.end();
      });
      
      credentials.claudeAiOauth.accessToken = response.access_token;
      credentials.claudeAiOauth.refreshToken = response.refresh_token;
      credentials.claudeAiOauth.expiresAt = Date.now() + (response.expires_in * 1000);
      
      const credentialsJson = JSON.stringify(credentials);
      this.writeCredentialsToFile(credentialsJson);
      
      Logger.info('Token refreshed successfully');
      return `Bearer ${response.access_token}`;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        const errorMsg = process.platform === 'win32' 
          ? 'Failed to load credentials: Claude credentials file not found in WSL. Check your default WSL distro with "wsl -l -v" and set the correct one with "wsl --set-default <distro-name>". As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
          : 'Claude credentials not found. Please ensure Claude Code is installed and you have logged in. As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)';
        Logger.error('ENOENT error during token refresh:', errorMsg);
        throw new Error(errorMsg);
      }
      if (error.message.includes('invalid_grant')) {
        throw new Error('Refresh token expired. Please log in again through Claude Code');
      }
      if (error.message.includes('timeout')) {
        throw new Error('Token refresh timeout. Please check your internet connection');
      }
      throw new Error(`Token refresh failed: ${error.message}`);
    }
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

    // Skip system prompt injection for Haiku models
    const isHaiku = body.model && body.model.toLowerCase().includes('haiku');

    if (!isHaiku) {
      const systemPrompt = {
        type: 'text',
        text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
      };

      if (body.system) {
        if (Array.isArray(body.system)) {
          body.system.unshift(systemPrompt);
        } else {
          body.system = [systemPrompt, { type: 'text', text: body.system }];
        }
      } else {
        body.system = [systemPrompt];
      }
    } else {
      Logger.debug('Skipping Claude Code system prompt for Haiku model');
    }

    if (presetName) {
      this.applyPreset(body, presetName);
    }

    body = this.stripTtlFromCacheControl(body);
    body = this.filterSamplingParams(body);

    return body;
  }

  loadPreset(presetName) {
    if (ClaudeRequest.presetCache.has(presetName)) {
      return ClaudeRequest.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      ClaudeRequest.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.info(`Failed to load preset ${presetName}: ${error.message}`);
      ClaudeRequest.presetCache.set(presetName, null);
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
      
      if (claudeResponse.statusCode === 401) {
        Logger.info('Got 401, checking credential store');
        ClaudeRequest.cachedToken = null;
        
        try {
          const newToken = await this.loadOrRefreshToken();
          ClaudeRequest.cachedToken = newToken;
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
          Logger.info('Token load/refresh failed, passing 401 to client');
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
      
      claudeResponse.on('error', (err) => {
        Logger.debug('Claude response stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      });
      
      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        if (!claudeResponse.destroyed) {
          claudeResponse.destroy();
        }
      });
      
      if (Logger.getLogLevel() >= 3) {
        const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);
        
        debugStream.on('error', (err) => {
          Logger.debug('Debug stream error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          if (!res.destroyed) {
            res.end(JSON.stringify({ error: 'Stream processing error' }));
          }
        });
        
        claudeResponse.pipe(debugStream).pipe(res);
        debugStream.on('end', () => {
          Logger.debug('\n');
          Logger.debug('Streaming response sent back to client');
        });
      } else {
        claudeResponse.pipe(res);
        claudeResponse.on('end', () => {
          Logger.debug('Streaming response sent back to client');
        });
      }
    } else {
      res.removeHeader('content-encoding');

      let responseData = '';
      claudeResponse.on('data', chunk => {
        responseData += chunk;
      });

      claudeResponse.on('error', (err) => {
        Logger.error('Claude non-streaming response error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
        }
      });

      claudeResponse.on('end', () => {
        Logger.debug(`Non-streaming response (${claudeResponse.statusCode}): ${responseData.substring(0, 500)}`);
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

  async refreshTokenWithClaudeCodeCli() {
    throw new Error('CLI token refresh not implemented');
  }
}

module.exports = ClaudeRequest;
