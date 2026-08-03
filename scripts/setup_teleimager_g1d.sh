#!/bin/bash
# G1-D: setup camera Unitree (teleimager) quando OpenCV V4L2 non basta.
# Uso sul Jetson:
#   cd ~/G1-TalkModule-OpenAiAPI
#   sed -i 's/\r$//' scripts/setup_teleimager_g1d.sh
#   bash scripts/setup_teleimager_g1d.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TELE_DIR="${TELEIMAGER_DIR:-$HOME/teleimager}"

echo "=== G1-D teleimager setup ==="

if [ ! -d "$TELE_DIR" ]; then
  echo "Clone teleimager in $TELE_DIR ..."
  git clone https://github.com/unitreerobotics/teleimager.git "$TELE_DIR"
fi

cd "$TELE_DIR"
echo "Install teleimager [server] ..."
pip install -e ".[server]" || pip install -e .

if [ -f setup_uvc.sh ]; then
  echo "Permessi UVC..."
  bash setup_uvc.sh || true
fi

echo ""
echo "1) Scopri camera:"
echo "   teleimager-server --cf"
echo ""
echo "2) Configura cam_config_server.yaml poi avvia:"
echo "   teleimager-server"
echo ""
echo "3) Test client:"
echo "   teleimager-client --host 127.0.0.1"
echo ""
echo "4) In config/camera.json puoi usare source=teleimager oppure lasciare v4l (fallback auto)."
echo "=============================================="
