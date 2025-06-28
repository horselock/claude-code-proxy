#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const TOKEN_CAPTURE_KEY = `CLAUDE_BEARER_TOKEN_INTERNAL_KEY_${Date.now()}`;
const TEMP_CAPTURE_FILENAME_BASE = `temp_capture_for_token_${Date.now()}`;
const TIMEOUT_DURATION_MS = 25000;
const CLAUDE_COMMAND = 'claude';
const CLAUDE_ARGS = ['-p', 'Hi.', '--system-prompt', 'This is a test. Reply with only one word.'];

const minimalInterceptorScriptContent = `
const http = require("http");
const https = require("https");

const TOKEN_STDOUT_KEY = process.env.CLAUDE_EXTRACT_TOKEN_STDOUT_KEY;
const TOKEN_TARGET_URL_SUBSTRING = "api.anthropic.com/v1/messages";
let tokenPrinted = false; // Global flag to ensure token is printed only once

if (!TOKEN_STDOUT_KEY) {
    // console.error("MinimalInterceptorError: CLAUDE_EXTRACT_TOKEN_STDOUT_KEY not set.");
    process.exit(1); 
}

function handleSuccessfulTokenValidation(token) {
    if (tokenPrinted) return;
    tokenPrinted = true;
    process.stdout.write(\`\${TOKEN_STDOUT_KEY}:\${String(token)}\\n\`);
    // The parent process will handle killing this child process upon receiving this stdout.
}

function checkAndProcessToken(headersContainer, url, requestOrResponsePromise) {
    if (tokenPrinted || !url || !url.includes(TOKEN_TARGET_URL_SUBSTRING)) {
        return;
    }

    let authHeader = null;
    if (headersContainer) {
        if (typeof headersContainer.get === 'function') { // e.g., Fetch API Headers object
            authHeader = headersContainer.get('Authorization') || headersContainer.get('authorization');
        } else if (typeof headersContainer === 'object') { // Plain object for headers
            authHeader = headersContainer['Authorization'] || headersContainer['authorization'];
        }
    }

    if (authHeader && String(authHeader).startsWith("Bearer ")) {
        const token = String(authHeader);

        if (requestOrResponsePromise instanceof Promise) { // Fetch API case
            requestOrResponsePromise.then(response => {
                if (response && response.ok) { // response.ok is true for statuses in the range 200-299
                    handleSuccessfulTokenValidation(token);
                }
            }).catch(err => {
                // Optional: log fetch error if needed for debugging the interceptor itself
                // console.error("MinimalInterceptorFetchError:", err.message);
            });
        } else if (requestOrResponsePromise && typeof requestOrResponsePromise.on === 'function') { // http.ClientRequest case
            requestOrResponsePromise.on('response', (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    handleSuccessfulTokenValidation(token);
                }
                // Consume response data to ensure 'end' event is emitted and resources are freed.
                // This is important for the request to complete properly.
                res.on('data', () => {});
                res.on('end', () => {});
            });
            requestOrResponsePromise.on('error', (err) => {
                // Optional: log request error if a request with a token fails
                // console.error("MinimalInterceptorRequestError:", err.message);
            });
        }
    }
}

function patchRequestMethod(originalRequestMethod, protocol) {
    return function (...args) {
        let url;
        let optionsObj = {};
        
        // Simplified argument parsing for http.request / https.request
        if (typeof args[0] === 'string' || args[0] instanceof URL) {
            try {
                const parsedUrl = new URL(args[0].toString());
                url = parsedUrl.href;
                if (args[1] && typeof args[1] === 'object') {
                    optionsObj = args[1];
                } else {
                    optionsObj = {}; 
                }
                if (!optionsObj.headers) optionsObj.headers = {};
            } catch(e) { /* ignore parse errors, let original handle */ }
        } else if (typeof args[0] === 'object' && args[0] !== null) {
            optionsObj = args[0];
            if (!optionsObj.headers) optionsObj.headers = {}; 
            if (optionsObj.href) { 
                url = optionsObj.href;
            } else {
                const proto = optionsObj.protocol || protocol + ':';
                const host = optionsObj.hostname || optionsObj.host || 'localhost';
                const portPart = optionsObj.port ? \`:\${optionsObj.port}\` : '';
                const pathPart = optionsObj.path || '/';
                url = \`\${proto}//\${host}\${portPart}\${pathPart}\`;
            }
        }
        
        const req = originalRequestMethod.apply(this, args);

        // Check for token in headers provided in the initial options object
        if (optionsObj.headers) {
            checkAndProcessToken(optionsObj.headers, url, req);
        }

        const originalSetHeader = req.setHeader;
        req.setHeader = function(name, value) {
            const result = originalSetHeader.apply(this, arguments);
            if (!tokenPrinted && name && typeof name === 'string' && name.toLowerCase() === 'authorization') {
                 checkAndProcessToken({ 'Authorization': value }, url, req);
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
    global.fetch = function (urlOrRequest, fetchOptions = {}) { // Note: can't be async if we return originalFetch's promise directly
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
        
        const responsePromise = originalFetch.apply(this, arguments);
        checkAndProcessToken(headersSource, urlString, responsePromise);
        return responsePromise;
    };
}
// process.stderr.write("MinimalInterceptor: Patched http/https/fetch methods (v2 awaiting response).\\n");
`;

// --- Main Script Logic (largely unchanged from original, timeout and interpretation of token differ) ---
async function main() {
    let tempDir = '';
    let tempInterceptorPath = '';
    let claudeProcess;
    let operationTimeoutId;
    let tokenFoundAndValidated = false; // Renamed for clarity
    let stdoutBuffer = "";
    let stderrBufferForDebugging = "";

    const cleanup = (exitCode) => {
        if (operationTimeoutId) clearTimeout(operationTimeoutId);
        if (claudeProcess && !claudeProcess.killed) {
            claudeProcess.kill('SIGKILL');
        }
        try {
            if (tempInterceptorPath && fs.existsSync(tempInterceptorPath)) {
                fs.unlinkSync(tempInterceptorPath);
            }
            if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {
            // console.error(`getToken_cleanup_error: Failed to delete temp file/dir: ${e.message}`);
        }
        process.exit(exitCode);
    };

    try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_CAPTURE_FILENAME_BASE}-`));
        tempInterceptorPath = path.join(tempDir, `${TEMP_CAPTURE_FILENAME_BASE}.js`);
        fs.writeFileSync(tempInterceptorPath, minimalInterceptorScriptContent);

        const currentNodeOptions = process.env.NODE_OPTIONS || '';
        const nodeOptionsForChild = `${currentNodeOptions} --require "${tempInterceptorPath}"`.trim();
        
        const childEnv = {
            ...process.env,
            NODE_OPTIONS: nodeOptionsForChild,
            CLAUDE_EXTRACT_TOKEN_STDOUT_KEY: TOKEN_CAPTURE_KEY,
            CLAUDE_API_LOG_FILE: os.platform() === 'win32' ? 'NUL' : '/dev/null',
            CLAUDE_DEBUG: 'false',
        };

        claudeProcess = spawn(CLAUDE_COMMAND, CLAUDE_ARGS, {
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        operationTimeoutId = setTimeout(() => {
            if (!tokenFoundAndValidated) {
                console.error(`getToken_error: Timeout (${TIMEOUT_DURATION_MS / 1000}s). Bearer token not captured and validated.`);
                if (stderrBufferForDebugging.length > 0) {
                    console.error("getToken_debug_stderr_begin ---");
                    console.error(stderrBufferForDebugging.slice(-1000));
                    console.error("getToken_debug_stderr_end ---");
                }
                cleanup(1);
            }
        }, TIMEOUT_DURATION_MS);

        claudeProcess.stdout.on('data', (data) => {
            if (tokenFoundAndValidated) return;
            stdoutBuffer += data.toString();
            
            const prefix = `${TOKEN_CAPTURE_KEY}:`;
            let matchIndex;
            while ((matchIndex = stdoutBuffer.indexOf(prefix)) !== -1) {
                const endOfLine = stdoutBuffer.indexOf('\n', matchIndex);
                if (endOfLine === -1) {
                    stdoutBuffer = stdoutBuffer.substring(matchIndex);
                    break;
                }

                const tokenLine = stdoutBuffer.substring(matchIndex + prefix.length, endOfLine).trim();
                if (tokenLine.startsWith("Bearer ")) {
                    tokenFoundAndValidated = true; // Token is now validated by the interceptor
                    clearTimeout(operationTimeoutId);
                    process.stdout.write(tokenLine + '\n');
                    
                    setTimeout(() => cleanup(0), 50); 
                    return; 
                }
                stdoutBuffer = stdoutBuffer.substring(endOfLine + 1);
            }
        });

        claudeProcess.stderr.on('data', (data) => {
            stderrBufferForDebugging += data.toString();
            // For live debugging:
            // process.stderr.write(`CLAUDE_STDERR: ${data.toString()}`);
        });

        claudeProcess.on('error', (err) => {
            if (tokenFoundAndValidated) return;
            console.error(`getToken_error: Failed to start/run '${CLAUDE_COMMAND}': ${err.message}`);
            cleanup(1);
        });

        claudeProcess.on('close', (code, signal) => {
            if (tokenFoundAndValidated) return;
            
            let exitMessage = `getToken_error: '${CLAUDE_COMMAND}' process exited `;
            if (code !== null) exitMessage += `with code ${code}. `;
            if (signal) exitMessage += `due to signal ${signal}. `;
            exitMessage += "Bearer token not captured and validated.";
            console.error(exitMessage);

            if (stderrBufferForDebugging.length > 0) {
                console.error("getToken_debug_stderr_at_close_begin ---");
                console.error(stderrBufferForDebugging.slice(-1000));
                console.error("getToken_debug_stderr_at_close_end ---");
            }
            cleanup(1);
        });

    } catch (error) {
        console.error(`getToken_error: An unexpected error occurred in main: ${error.message}`);
        if (error.stack) console.error(error.stack.split('\n').slice(0, 5).join('\n'));
        cleanup(1);
    }
}

if (require.main === module) {
    main();
} else {
    console.error("getToken_error: This script should be run directly, not imported as a module.");
    process.exit(1);
}

