## Utils
Some of these may have been used as backup options for the app but may not necessarily still be. Leaving them up because they are useful.

### claude-bearer.js
claude-bearer.js sends a test message through claude code and grabs the Authorization header from the last successful response it sees. If on Windows, run it in wsl using `node claude-bearer.js`. May be found in:
- ~/.claude/.credentials.json

### gemini-bearer.js
(may add Gemini functionality in the future) Same as above, but not in wsl - run it wherever you have gemini-cli installed (just in cmd if you aren't sure) with `node gemini-bearer.js`. This can be found in:
- ~/.gemini/oauth_creds.json
- C:\Users\your-user-name\.gemini\oauth_creds.json

### claude-curl.txt
Example of a working Claude curl command