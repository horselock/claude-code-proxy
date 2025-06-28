# claude-code-proxy
## About
Mostly vibe coded, don't @ me

Basically we can borrow Claude Code subscription authentication to make normal API calls at will, using claude.ai limit rather than API prices.

There is no safety injection (that I've noticed so far) and it gives us full control of the entire input, minus a tiny required sentence about being Claude Code in the system prompt (check

## Quick Start
Requires: 
- nvm, node
- Claude Code installed with nvm, login with "Claude account with subscription"
1. `git clone https://github.com/horselock/claude-code-proxy.git`
2. `run.sh` or `run.bat` depending on your OS; default port is 42069

- This is NOT an OpenAI compatible proxy - it accepts Anthropic's API structure

- Only exact dated model names of Sonnet 4, 3.7, 3.6, and Haiku 3.5 are allowed. Opus is allowed if you have Max.

- Make sure you understand your front end's caching

### Alt Docker steps
1. `CLAUDE_PATH=$(which claude) docker-compose up` (windows must enter this from wsl, with docker open obviously)

## Beginner Guide
As you can see by the Quick Start, like 95% of the setup is making sure you have Claude Code and your local front end are set up right. This utility's setup by itself is pretty much "run the server and point your front end at it." 

This guide assumes windows (untested on Linux/Mac but should work fine, and if you're on Linux you probably don't need my help), and no wsl/nvm/node already installed. Just skip any sections you already have done.

### Install Claude Code (If you didn't install with `nvm`, you may have to redo - it's better anyway)
#### wsl
1. Open a command line and run `wsl --install`. Follow instructions. If you aren't already in by the end, `wsl` (either in command line or from start menu) to enter the shell, you should get colors and a dollar sign and shit:
<img width="216" alt="image" src="https://github.com/user-attachments/assets/f100bbf6-045a-4cd5-8048-fce7c52b1ab9" />

#### nvm
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
2. Double-click `run.bat` (Windows) or `run.sh` (Mac/Linux) - first run will auto-install dependencies
3. Go into SillyTavern and point the Claude connection to that proxy:

<img width="638" alt="image" src="https://github.com/user-attachments/assets/3b94e5c4-d52d-4ee8-8d26-675ba667f7a8" />

- URL = `http://localhost:42069/v1`
- Literally anything for password, just don't leave blank.
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

## What This Does
- Adds headers (Authorization plus a couple specified in config.txt) to trick the endpoint into thinking the request is coming from a real Claude Code application.
- Remove "ttl" key from any "cache_control" objects, since endpoint does not allow it
- The first section of the system prompt must be "You are Claude Code, Anthropic's official CLI for Claude." or the request will not be accepted by Anthropic (specifically/technically, it must be the first item of the "system" array's "text" content). I am adding this, but this is just FYI so you know it's there and that you have to deal with it.

## Todo
- Implement intelligent caching to deal with SillyTavern features

## Changelog
- 0.0.0 - new
- idk i missed a few
- 0.2.0 - refactored to node and a smarter way of getting credentials. app no longer handles caching (will bring it back when I'm confident in a better design)
- 0.3.0 - docker
