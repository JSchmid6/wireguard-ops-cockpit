# Install the package htop via aptget
> Generated 2026-07-12T10:12:06.785Z

## Prompt
Install the package htop via apt-get

## Planner Output
```
## Required Permissions
/usr/bin/apt-get
/usr/bin/dpkg
'''bash
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if /usr/bin/dpkg -s htop &>/dev/null; then
    echo "htop is already installed."
    exit 0
fi
/usr/bin/apt-get update -qq
/usr/bin/apt-get install -y -qq htop
echo "htop installed successfully."
'''
```