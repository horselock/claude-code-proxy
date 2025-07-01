const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');

let config = {};
let claudeRequest;

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    
    Logger.init(config);
    claudeRequest = new ClaudeRequest(config);
    
    console.log('Config loaded from config.txt');
  } catch (error) {
    console.error('Failed to load config:', error.message);
    process.exit(1);
  }
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.socket.remoteAddress || 
         '127.0.0.1';
}

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function createTimeout(callback, errorMessage, timeoutMs = 10000) {
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    
    const timeoutHandler = createTimeout(reject, 'Request body parsing timed out after 10000ms');
    
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      if (!timeoutHandler.isResolved()) {
        timeoutHandler.clear();
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      }
    });
    req.on('error', (err) => {
      if (!timeoutHandler.isResolved()) {
        timeoutHandler.clear();
        reject(err);
      }
    });
  });
}

async function startServer() {
  loadConfig();
  
  const server = http.createServer(async (req, res) => {
    const clientIP = getClientIP(req);
    const parsedUrl = url.parse(req.url, true);
    console.log(`${req.method} ${req.url} from ${clientIP}`);
    
    setCORSHeaders(res);
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
      return;
    }
    
    if (req.method === 'POST' && parsedUrl.pathname === '/v1/messages') {
      try {
        const body = await parseBody(req);
        Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
        Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));
        
        await claudeRequest.handleResponse(res, body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }
    
    const presetMatch = parsedUrl.pathname.match(/^\/v1\/([^\/]+)\/messages$/);
    if (req.method === 'POST' && presetMatch) {
      try {
        const presetName = presetMatch[1];
        const body = await parseBody(req);
        Logger.debug(`Detected preset: ${presetName}`);
        Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
        Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));
        
        await claudeRequest.handleResponse(res, body, presetName);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const port = parseInt(config.port) || 3000;
  const host = config.host || 'localhost';
  
  server.listen(port, host, () => {
    console.log(`claude-code-proxy server listening on ${host}:${port}`);
  });
  
  server.on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
