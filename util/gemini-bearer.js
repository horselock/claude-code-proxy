#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const TOKEN_CAPTURE_KEY = `GEMINI_BEARER_TOKEN_INTERNAL_KEY_${Date.now()}`;
const TEMP_CAPTURE_FILENAME_BASE = `temp_capture_for_gemini_token_${Date.now()}`;
const TIMEOUT_DURATION_MS = 15000; // 15 seconds is plenty of time to just find the request
const GEMINI_COMMAND = 'gemini';
const GEMINI_ARGS = ['--prompt', 'Hi.'];

const minimalInterceptorScriptContent = `
const http = require("http");
const https = require("https");

const TOKEN_STDOUT_KEY = process.env.GEMINI_EXTRACT_TOKEN_STDOUT_KEY;
const TOKEN_TARGET_URL_SUBSTRING = "cloudcode-pa.googleapis.com";
const TOKEN_HEADER_NAME = "authorization";
let tokenPrinted = false;

if (!TOKEN_STDOUT_KEY) {
    process.exit(1); 
}

function checkAndProcessToken(headersContainer, url) {
    if (tokenPrinted || !url || !url.includes(TOKEN_TARGET_URL_SUBSTRING)) {
        return;
    }

    let authHeader = null;
    if (headersContainer) {
        if (typeof headersContainer.get === 'function') {
            authHeader = headersContainer.get(TOKEN_HEADER_NAME);
        } else if (typeof headersContainer === 'object') {
            authHeader = headersContainer[TOKEN_HEADER_NAME] || headersContainer['Authorization'];
        }
    }

    if (authHeader && String(authHeader).toLowerCase().startsWith("bearer ")) {
        tokenPrinted = true;
        process.stdout.write(\`\${TOKEN_STDOUT_KEY}:\${String(authHeader)}\\n\`);
    }
}

function patchRequestMethod(originalRequestMethod, protocol) {
    return function (...args) {
        let url;
        let optionsObj = {};
        
        if (typeof args[0] === 'string' || args[0] instanceof URL) {
            try {
                url = new URL(args[0].toString()).href;
                optionsObj = args[1] && typeof args[1] === 'object' ? args[1] : {};
            } catch(e) {}
        } else if (typeof args[0] === 'object' && args[0] !== null) {
            optionsObj = args[0];
            const proto = optionsObj.protocol || protocol + ':';
            const host = optionsObj.hostname || optionsObj.host || 'localhost';
            const portPart = optionsObj.port ? \`:\${optionsObj.port}\` : '';
            const pathPart = optionsObj.path || '/';
            url = \`\${proto}//\${host}\${portPart}\${pathPart}\`;
        }
        if (!optionsObj.headers) optionsObj.headers = {};
        
        checkAndProcessToken(optionsObj.headers, url);
        
        const req = originalRequestMethod.apply(this, args);

        const originalSetHeader = req.setHeader;
        req.setHeader = function(name, value) {
            const result = originalSetHeader.apply(this, arguments);
            if (name && typeof name === 'string' && name.toLowerCase() === TOKEN_HEADER_NAME) {
                 checkAndProcessToken({ [TOKEN_HEADER_NAME]: value }, url);
            }
            return result;
        };
        return req;
    };
}

http.request = patchRequestMethod(http.request, "http");
https.request = patchRequestMethod(https.request, "https");

if (typeof global.fetch === 'function') {
    const originalFetch = global.fetch;
    global.fetch = function (urlOrRequest, fetchOptions = {}) {
        let urlString = '';
        let headersSource = fetchOptions.headers; 
        if (typeof urlOrRequest === 'string') {
            urlString = urlOrRequest;
        } else if (urlOrRequest instanceof Request) { 
            urlString = urlOrRequest.url;
            headersSource = urlOrRequest.headers; 
        } else if (urlOrRequest && typeof urlOrRequest.href === 'string') { 
            urlString = urlOrRequest.href;
        }
        checkAndProcessToken(headersSource, urlString);
        return originalFetch.apply(this, arguments);
    };
}
`;

async function main() {
    let tempDir = '';
    let tempInterceptorPath = '';
    let geminiProcess;
    let operationTimeoutId;
    let tokenFound = false;

    const cleanup = (exitCode) => {
        if (operationTimeoutId) clearTimeout(operationTimeoutId);
        if (geminiProcess && !geminiProcess.killed) {
            geminiProcess.kill('SIGKILL');
        }
        try {
            if (tempInterceptorPath && fs.existsSync(tempInterceptorPath)) {
                fs.unlinkSync(tempInterceptorPath);
            }
            if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error(`getToken_cleanup_error: ${e.message}`);
        }
        process.exit(exitCode);
    };

    try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_CAPTURE_FILENAME_BASE}-`));
        tempInterceptorPath = path.join(tempDir, `${TEMP_CAPTURE_FILENAME_BASE}.js`);
        fs.writeFileSync(tempInterceptorPath, minimalInterceptorScriptContent);

        const currentNodeOptions = process.env.NODE_OPTIONS || '';
        const requirePath = os.platform() === 'win32' 
            ? tempInterceptorPath.replace(/\\/g, '/') 
            : tempInterceptorPath;
        const nodeOptionsForChild = `${currentNodeOptions} --require "${requirePath}"`.trim();
        
        const childEnv = {
            ...process.env,
            NODE_OPTIONS: nodeOptionsForChild,
            GEMINI_EXTRACT_TOKEN_STDOUT_KEY: TOKEN_CAPTURE_KEY,
        };

        geminiProcess = spawn(GEMINI_COMMAND, GEMINI_ARGS, {
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout and stderr
            shell: os.platform() === 'win32' 
        });

        operationTimeoutId = setTimeout(() => {
            if (!tokenFound) {
                console.error(`getToken_error: Timeout. Bearer token not found in any request.`);
                cleanup(1);
            }
        }, TIMEOUT_DURATION_MS);

        // Handle the child's stdout
        let stdoutBuffer = "";
        geminiProcess.stdout.on('data', (data) => {
            if (tokenFound) return;
            stdoutBuffer += data.toString();
            
            const prefix = `${TOKEN_CAPTURE_KEY}:`;
            const matchIndex = stdoutBuffer.indexOf(prefix);

            if (matchIndex !== -1) {
                const endOfLine = stdoutBuffer.indexOf('\n', matchIndex);
                if (endOfLine !== -1) {
                    const tokenLine = stdoutBuffer.substring(matchIndex + prefix.length, endOfLine).trim();
                    if (tokenLine.toLowerCase().startsWith("bearer ")) {
                        tokenFound = true;
                        clearTimeout(operationTimeoutId);
                        // This is the ONLY thing that should go to the real stdout.
                        process.stdout.write(tokenLine + '\n');
                        cleanup(0); // Success
                    }
                }
            }
        });

        geminiProcess.stderr.on('data', (data) => {
            process.stderr.write(data);
        });

        geminiProcess.on('error', (err) => {
            console.error(`getToken_error: Failed to start '${GEMINI_COMMAND}': ${err.message}`);
            cleanup(1);
        });

        geminiProcess.on('close', (code) => {
            if (!tokenFound) {
                console.error(`getToken_error: '${GEMINI_COMMAND}' process exited (code: ${code}) before a token could be captured.`);
                cleanup(1);
            }
        });

    } catch (error) {
        console.error(`getToken_error: An unexpected error occurred: ${error.message}`);
        cleanup(1);
    }
}

if (require.main === module) {
    main();
}