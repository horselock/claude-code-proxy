const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');

let config = {};
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
    
    console.log('Config loaded from config.txt');
  } catch (error) {
    console.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         '127.0.0.1';
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const { pathname } = url.parse(req.url);
  
  console.log(`${req.method} ${pathname} from ${clientIP}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
    return;
  }
  
  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));
      
      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];
        Logger.debug(`Detected preset: ${presetName}`);
      }
      
      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      console.error('Request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  loadConfig();
  
  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;
  const host = config.host || 'localhost';
  
  server.listen(port, host, () => {
    console.log(`claude-code-proxy server listening on ${host}:${port}`);
  });
  
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
  });
  
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
