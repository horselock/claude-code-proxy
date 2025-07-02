# claude-code-proxy
## About

Mostly vibe coded, don't @ me

Basically we can borrow Claude Code subscription authentication to make normal API calls at will, using claude.ai limit rather than API prices.

There seems to be no safety injection and it gives us full control of the entire input, minus a tiny required sentence about being Claude Code in the system prompt (check What This Does section)

And it may not necessarily even be against ToS! https://github.com/grll/claude-code-action/issues/6#issue-3103072456

## Quick Start
Requires: 
- nvm, node (installed with nvm), Claude Code, logged in with "Claude account with subscription"
1. `git clone https://github.com/horselock/claude-code-proxy.git`
2. `run.sh` or `run.bat` depending on your OS; default port is 42069

- NOT an OpenAI compatible proxy, uses Anthropic's schema 
- Only exact dated model names of Sonnet 4, 3.7, 3.6, and Haiku 3.5 are allowed. Opus 4 too with Max.
- Understand your front end's caching, some disabled by default, complex setups may have pitfalls.

### Alternate Docker steps
1. `docker-compose up` (Windows must enter this from wsl, with docker open obviously)

## Beginner/Thorough Guide
As you can see by the Quick Start, like 95% of the setup is making sure you have Claude Code and your local front end are set up right. This utility's setup by itself is pretty much "run the server and point your front end at it." 

This guide assumes windows (untested on Linux/Mac but should work fine, and if you're on Linux you probably don't need my help), and no wsl/nvm/node already installed. Just skip any sections you already have done.

### Install Claude Code 

#### wsl
1. Open a command line and run `wsl --install`. Follow instructions. If you aren't already in by the end, `wsl` (either in command line or from start menu) to enter the shell, you should get colors and a dollar sign: [example](https://www.jeremymorgan.com/images/customize-wsl-terminal/customize-wsl-terminal-01.jpg)

#### nvm and node
Even if you already have node in Windows, you'll need it again in wsl. If you already installed it NOT with nvm (Node Version Manager), remove it (ask Claude to guide if unsure) and reinstall - it's better anyway.

1. While in wsl, install nvm t: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash` - See [their guide](https://github.com/nvm-sh/nvm?tab=readme-ov-file#install--update-script) for latest version.
2. Still in the colorful wsl terminal, install node: `nvm install --lts` - LTS stands for long term support

#### claude code
While in wsl terminal, run `npm install -g @anthropic-ai/claude-code`

Details here: https://docs.anthropic.com/en/docs/claude-code/setup

You're done!

### Install SillyTavern (or any front end of your choice, but I'm only walking through ST)
1. https://docs.sillytavern.app/installation/windows/ - I think their "installer" option is actually really easy, should take care of everything.
2. FYI: In the leftmost tab of "AI Response Configruation", you'll want to check "Use system prompt". This is also where you toggle thinking (reasoning effort), and most things, really.

### My Application
1. Install Git for Windows and run (in command line or powershell) `git clone https://github.com/horselock/claude-code-proxy.git`. If you really really don't want git, then download and unzip the whole project.
2. Double-click `run.bat` (Windows) or `run.sh` (Mac/Linux)
3. Go into SillyTavern and point the Claude connection to that proxy:

<img width="638" alt="image" src="https://github.com/user-attachments/assets/3b94e5c4-d52d-4ee8-8d26-675ba667f7a8" />

- URL = `http://localhost:42069/v1`
- Literally anything for password, just don't leave blank. As a backup option, you may put your oauth access token here (see Troubleshooting section)
- You have to pick a specific name for the model, can't pick "latest". Have to have a date at the end. Only Sonnet (20241022 or later) and 3.5 Haiku are allowed plus Opus with Max. 
- Save the preset as "Claude Code Proxy" or whatever you want.
- Click "Connect"

### Optional (but important to read for ST noobs)
- Strip down SillyTavern to make it a plain chat client. Not saying you necessarily *should* do this, but it's useful to know how to do it.
  - In leftmost tab, open the "Utility Prompts" drop-down and delete "[Start a new Chat]" - this would put that line at convo start, weird and unnecessary.
  - In leftmost tab, scroll down to "Main Prompt" and delete or disable it.
  - In the rightmost tab, click on the pre-made "Assistant" character.
  - You now have a baseline of a "pure" API call, feel free to explore ST's features from there!
- Probably should increase Max Tokens so responses don't get cut off.
- Try loading up Pyrite, my jailbroken persona!
  - I've pre-loaded Pyrite on the server. Just set your url to `http://localhost:42069/v1/pyrite`! This is meant for people who JUST installed a front and and don't have a real setup yet - it's nice to be able to celebrate your victory with something working right away!
- Read up on how SillyTavern handles caching: https://docs.sillytavern.app/administration/config-yaml/#claude-configuration
  - It's off by default, turn it on with those configs. Choose depth 0 if you aren't sure.
  - What all those warnings mean is that for cache to be use, everything up to a certain point has to be the exact same. ST has a lot of advanced features where it makes changes to the start of the context, ruining your savings. But for simpler use cases, it's fine. Set the context to 200K IMO - because as stuff falls out of context if you choose a lower number, that also 

### Troubleshooting
Most likely thing to go wrong is not being able to find the credentials, either due to permissions or location.
- Ensure you installed node in wsl with nvm, if not, just redo it.
- Make sure your wsl default is Ubuntu (the default distro that comes with wsl)
- If all else fails, go to wsl, `cat ~/.claude/.credentials.json`, copy out the access token (send a message in Claude Code first to make sure it's not expired), and put it in the authentication header. In ST this is the Proxy "password". 
  - If that's one too steps, you can go to util folder, enter wsl in the address bar, and run `claude-bearer.js` - that'll make sure it's not expired, and you'll get the token delivered to you. You don't have to copy "Bearer"
- If you tend to leave Claude Code open for hours, you may find yourself logged out. This means the access token expired and this proxy renewed it, but  Claude Code just sits there upset that it's expired instead of just checking the file. Just close Claude Code, it'll be fine when you open it again.

## What This Does
- Adds headers (Authorization plus a couple specified in config.txt) to trick the endpoint into thinking the request is coming from a real Claude Code application.
- Remove "ttl" key from any "cache_control" objects, since endpoint does not allow it
- The first section of the system prompt must be "You are Claude Code, Anthropic's official CLI for Claude." or the request will not be accepted by Anthropic (specifically/technically, it must be the first item of the "system" array's "text" content). I am adding this, but this is just FYI so you know it's there and that you have to deal with it.

## Todo
- Implement intelligent caching to deal with SillyTavern features
- Possibly auto-refreshing creds with CLI option
