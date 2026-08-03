#!/bin/bash
# Occhi robot G1 → stream dashboard (percorso unico e sicuro sul Jetson).
#
# Cosa fa:
#   1. Rileva RealSense USB (8086:0b3a) oppure camera V4L2 normale (G1-D)
#   2. Scrive config/camera.json (priorità su G1_CAMERA_* in .env)
#   3. Per RealSense: installa pyrealsense2 nel .venv
#   4. Test frame + istruzioni restart
#
# Uso (sul Jetson):
#   cd ~/G1-TalkModule-OpenAiAPI
#   sed -i 's/\r$//' scripts/setup_robot_eyes.sh
#   bash scripts/setup_robot_eyes.sh          # auto: RealSense se presente, altrimenti v4l
#   bash scripts/setup_robot_eyes.sh --v4l    # forza camera USB normale (G1-D)
#   bash scripts/setup_robot_eyes.sh --realsense
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$PROJECT_ROOT/.venv"
PYTHON="$VENV/bin/python3"
ENV_FILE="$PROJECT_ROOT/.env"
CAMERA_JSON="$PROJECT_ROOT/config/camera.json"

MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --v4l|--usb) MODE="v4l" ;;
    --realsense) MODE="realsense" ;;
    --auto) MODE="auto" ;;
  esac
done

cd "$PROJECT_ROOT"
mkdir -p config

echo "=============================================="
echo " G1 — setup occhi robot per dashboard"
echo "=============================================="

HAS_RS=0
if lsusb 2>/dev/null | grep -qi '8086:0b3a\|Intel Corp.*RealSense'; then
  HAS_RS=1
fi

if [ "$MODE" = "auto" ]; then
  if [ "$HAS_RS" -eq 1 ]; then
    MODE="realsense"
  else
    MODE="v4l"
  fi
fi

echo "Modalità camera: $MODE (RealSense USB=$HAS_RS)"

if [ "$MODE" = "realsense" ]; then
  if "$PYTHON" -c "import pyrealsense2 as rs; print('pyrealsense2 già OK:', rs.__version__)" 2>/dev/null; then
    echo "== pyrealsense2 già funzionante nel venv =="
  else
    echo "== Installazione pyrealsense2 (compilazione locale) =="
    bash "$PROJECT_ROOT/scripts/install_realsense_jetson.sh"
  fi
  cat > "$CAMERA_JSON" << 'JSON'
{
  "source": "realsense",
  "device": "auto",
  "width": 640,
  "height": 480,
  "fps": 15,
  "yolo": true,
  "depth": true,
  "comment": "G1 con RealSense integrata"
}
JSON
else
  cat > "$CAMERA_JSON" << 'JSON'
{
  "source": "v4l",
  "device": "auto",
  "width": 640,
  "height": 480,
  "fps": 15,
  "yolo": true,
  "depth": false,
  "comment": "G1-D: camera USB/V4L2 normale"
}
JSON
fi

echo "== config/camera.json scritto =="
cat "$CAMERA_JSON"

touch "$ENV_FILE"
if ! grep -q '^G1_YOLO_BACKEND=' "$ENV_FILE"; then
  echo 'G1_YOLO_BACKEND=onnx' >> "$ENV_FILE"
fi
if ! grep -q '^G1_CAMERA_YOLO=' "$ENV_FILE"; then
  echo 'G1_CAMERA_YOLO=1' >> "$ENV_FILE"
fi

echo "== Test frame occhi =="
if [ "$MODE" = "realsense" ]; then
  "$PYTHON" << 'PY'
import pyrealsense2 as rs
import numpy as np

p = rs.pipeline()
c = rs.config()
c.enable_stream(rs.stream.color, 640, 480, rs.format.bgr8, 15)
p.start(c)
frames = p.wait_for_frames(8000)
img = np.asanyarray(frames.get_color_frame().get_data())
print("OK RealSense frame:", img.shape)
p.stop()
PY
else
  "$PYTHON" << 'PY'
import glob
import cv2

dev = None
for path in sorted(glob.glob("/dev/video*")):
    try:
        idx = int(path.rsplit("/", 1)[-1].replace("video", ""))
    except ValueError:
        continue
    cap = cv2.VideoCapture(idx)
    if not cap.isOpened():
        cap.release()
        continue
    ok, frame = cap.read()
    cap.release()
    if ok and frame is not None:
        dev = idx
        print(f"OK V4L2 frame da /dev/video{idx}:", frame.shape)
        break
if dev is None:
    raise SystemExit("Nessuna camera V4L2 trovata (ls /dev/video*)")
PY
fi

echo ""
echo "=============================================="
echo " PROSSIMO PASSO"
echo "=============================================="
echo "  bash scripts/restart_server.sh"
echo ""
echo " Poi dal PC (Ctrl+F5):"
echo "  https://192.168.123.164:8081/client#occhi"
echo ""
echo " Verifica API:"
echo "  curl -sk https://127.0.0.1:8081/api/camera/status"
echo "  curl -sk -X POST https://127.0.0.1:8081/api/camera/reload"
echo "=============================================="
