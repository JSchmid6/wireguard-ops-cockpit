#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if /usr/bin/dpkg -s gh &>/dev/null; then
    echo "gh is already installed."
    /usr/bin/which gh
    /usr/bin/gh --version
    exit 0
fi

/usr/bin/apt-get update -qq
/usr/bin/apt-get install -y -qq gh
echo "gh installed successfully."
/usr/bin/which gh
/usr/bin/gh --version
