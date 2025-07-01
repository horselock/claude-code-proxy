const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Logger = require('./Logger');

const STRIP_TTL = true;

class ClaudeRequest {
  static cachedToken = null;
  static presetCache = new Map();
  static refreshPromise = null;

  constructor(req = null) {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
    
    // Check for x-api-key header first
    const apiKey = req?.headers?.['x-api-key'];
    if (apiKey && apiKey.startsWith('Bearer ')) {
      this.currentToken = apiKey;
    } else {
      this.currentToken = ClaudeRequest.cachedToken;
    }
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

  async getAuthToken() {
    if (this.currentToken) {
      return this.currentToken;
    }

    const token = await this.loadOrRefreshToken();
    ClaudeRequest.cachedToken = token;
    this.currentToken = token;
    return token;
  }

  async loadOrRefreshToken() {
    try {
      const token = await this.loadTokenFromCredentials();
      if (token) {
        this.currentToken = token;
        return token;
      }
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  loadCredentialsFromFile() {
    if (process.platform === 'win32') {
      return execSync('wsl cat ~/.claude/.credentials.json', { 
        encoding: 'utf8', 
        timeout: 10000 
      });
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      return fs.readFileSync(credentialsPath, 'utf8');
    }
  }

  writeCredentialsToFile(credentialsJson) {
    if (process.platform === 'win32') {
      execSync(`wsl tee ~/.claude/.credentials.json > /dev/null`, { input: credentialsJson, encoding: 'utf8', timeout: 10000 });
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.writeFileSync(credentialsPath, credentialsJson, 'utf8');
    }
  }

  async loadTokenFromCredentials() {
    try {
      const credentialsData = this.loadCredentialsFromFile();

      const credentials = JSON.parse(credentialsData);
      
      if (!credentials.claudeAiOauth?.accessToken) {
        throw new Error('No access token found');
      }

      const oauth = credentials.claudeAiOauth;
      
      if (oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000)) {
        console.log('Token expires soon, preemptively refreshing...');
        return await this.refreshTokenWithClaudeCode();
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

  async refreshTokenWithClaudeCode() {
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
      console.log('Attempting to refresh token...');
      
      // Load current credentials to get refresh token
      const credentialsData = this.loadCredentialsFromFile();

      const credentials = JSON.parse(credentialsData);
      const refreshToken = credentials.claudeAiOauth?.refreshToken;
      
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      // Make refresh request to Anthropic OAuth endpoint
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

        // Request timeout
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('OAuth request timeout'));
        });

        req.on('error', reject);
        req.write(JSON.stringify(refreshData));
        req.end();
      });
      
      // Update credentials file atomically
      credentials.claudeAiOauth.accessToken = response.access_token;
      credentials.claudeAiOauth.refreshToken = response.refresh_token;
      credentials.claudeAiOauth.expiresAt = Date.now() + (response.expires_in * 1000);
      
      const credentialsJson = JSON.stringify(credentials);
      this.writeCredentialsToFile(credentialsJson);
      
      console.log('Token refreshed successfully');
      return `Bearer ${response.access_token}`;
      
    } catch (error) {
      // Better error context
      if (error.code === 'ENOENT') {
        const errorMsg = process.platform === 'win32' 
          ? 'Failed to load credentials: Claude credentials file not found in WSL. Check your default WSL distro with "wsl -l -v" and set the correct one with "wsl --set-default <distro-name>". As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
          : 'Claude credentials not found. Please ensure Claude Code is installed and you have logged in. As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)';
        console.error('ENOENT error during token refresh:', errorMsg);
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
      console.log(`Failed to load preset ${presetName}: ${error.message}`);
      ClaudeRequest.presetCache.set(presetName, null);
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
        ClaudeRequest.cachedToken = null;
        this.currentToken = null;
        
        try {
          const newToken = await this.refreshTokenWithClaudeCode();
          this.currentToken = newToken;
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
        // Only use debug stream if we're actually logging debug level
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
        // Direct pipe when not debugging
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
