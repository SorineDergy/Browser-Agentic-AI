import base64
import math
import re
from collections import Counter
import cv2
import mediapipe as mp
import numpy as np
import pytesseract
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pytesseract import Output
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # PLEASE REPLACE THIS WILDCARD WITH THE CHROME EXTENSION ID LATER
    allow_methods=["POST"],
    allow_headers=["*"],
)
class BlurRequest(BaseModel):
    image: str  # data URL: "data:image/png;base64,...."


class BlurResponse(BaseModel):
    image: str


_mp_face_detection = mp.solutions.face_detection
_face_detector = _mp_face_detection.FaceDetection(
    model_selection=0, min_detection_confidence=0.5
)

# This is for a seperate name detection thing to try LATER, name detection is too inconsitent coz no patterns <\3 (please do NOT change this to true and commit too the repositry, thanks :3 )
#  {if you wanna mess with this, create a branched repo for testing}
ENABLE_NAME_DETECTION = False
_nlp = None
if ENABLE_NAME_DETECTION:
    import spacy
    print("Loading spaCy NER model (this happens once, at startup)...")
    _nlp = spacy.load("en_core_web_sm")

print("Models loaded.")

# REGEX, NO TOUCHIE
PII_PATTERNS = {
    "email": r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
    "phone": r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b",
    "ssn_or_id": r"\b\d{3}-\d{2}-\d{4}\b",
    "credit_card": r"\b(?:\d[ -]*?){13,19}\b",
}

# Known API key and token formats (yeah gotta blur those too lol)
API_KEY_PATTERNS = {
    "aws_key": r"AKIA[0-9A-Z]{16}",
    "github_token": r"gh[pousr]_[A-Za-z0-9]{36,}",
    "stripe_key": r"sk_live_[A-Za-z0-9]{24,}",
    "slack_token": r"xox[baprs]-[A-Za-z0-9-]{10,}",
    "jwt": r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
}

def luhn_valid(number_str: str) -> bool:
    """Standard Luhn checksum — confirms a digit string is *structurally*
    a valid card number, not just any 13-19 digit sequence."""
    digits = [int(d) for d in re.sub(r"\D", "", number_str)]
    if not (13 <= len(digits) <= 19):
        return False
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def shannon_entropy(s: str) -> float:
    """Higher entropy = more 'random-looking'. Regular words/sentences
    score low; secrets/tokens score high. Used to catch generic API keys
    that don't match a known provider's format."""
    if not s:
        return 0.0
    counts = Counter(s)
    length = len(s)
    return -sum((c / length) * math.log2(c / length) for c in counts.values())


def looks_like_generic_secret(text: str) -> bool:
    # Long, no spaces, mixed alphanumeric, high entropy — heuristic for
    # "some kind of token/key" even without a recognized prefix.
    candidate = text.strip()
    if len(candidate) < 20 or " " in candidate:
        return False
    if not re.match(r"^[A-Za-z0-9_\-.]+$", candidate):
        return False
    return shannon_entropy(candidate) > 3.5  # tune threshold against real examples


def contains_pii(text: str) -> bool:
    text_clean = text.strip()

    for pii_type, pattern in PII_PATTERNS.items():
        match = re.search(pattern, text_clean)
        if match:
            if pii_type == "credit_card" and not luhn_valid(match.group()):
                continue  # regex matched digits, but it's not a real card number
            print(f"Detected {pii_type}: {text_clean}")
            return True

    for key_type, pattern in API_KEY_PATTERNS.items():
        if re.search(pattern, text_clean):
            print(f"Detected {key_type}")
            return True

    if looks_like_generic_secret(text_clean):
        print(f"Detected likely secret (entropy): {text_clean}")
        return True

    if _nlp is not None:
        doc = _nlp(text_clean)
        if any(ent.label_ == "PERSON" for ent in doc.ents):
            print(f"Detected name: {text_clean}")
            return True

    return False

def blur_kernel_for_box(x1, y1, x2, y2, strength=0.5):
    """Kernel size scales with the box's own dimensions, so bigger
    faces/regions get proportionally more blur, not a fixed amount."""
    w, h = x2 - x1, y2 - y1
    k = int(min(w, h) * strength)
    k = max(k, 15)          # floor, so tiny boxes still get a real blur
    if k % 2 == 0:
        k += 1              # must be odd
    return (k, k)

def apply_blur(image, x1, y1, x2, y2, kernel_size=(101, 101)):
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(image.shape[1], x2), min(image.shape[0], y2)

    if x2 > x1 and y2 > y1:
        roi = image[y1:y2, x1:x2]
        blurred_roi = cv2.GaussianBlur(roi, kernel_size, 0)
        image[y1:y2, x1:x2] = blurred_roi


def blur_pii_and_faces(image: np.ndarray) -> np.ndarray:
    h, w, _ = image.shape

    # 1. SCAN AND BLUR TEXT PII (Tesseract) - (moved away from EasyOCR coz like that too slow)
    # image_to_data gives per-word boxes 
    ocr_data = pytesseract.image_to_data(image, output_type=Output.DICT)
    n_boxes = len(ocr_data["text"])
    for i in range(n_boxes):
        text = ocr_data["text"][i]
        if not text or not text.strip():
            continue
        conf = int(ocr_data["conf"][i]) if ocr_data["conf"][i] != "-1" else -1
        if conf < 30:  # skip low-confidence garbage detections
            continue
        if contains_pii(text):
            x, y, box_w, box_h = (
                ocr_data["left"][i], ocr_data["top"][i],
                ocr_data["width"][i], ocr_data["height"][i],
            )
            apply_blur(image, x, y, x + box_w, y + box_h)

    # 2. SCAN AND BLUR FACES (MediaPipe)
    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    face_results = _face_detector.process(image_rgb)

    if face_results.detections:
        for detection in face_results.detections:
            box = detection.location_data.relative_bounding_box
            x1 = int(box.xmin * w)
            y1 = int(box.ymin * h)
            x2 = x1 + int(box.width * w)
            y2 = y1 + int(box.height * h)
            apply_blur(image, x1, y1, x2, y2, kernel_size=blur_kernel_for_box(x1, y1, x2, y2))

    return image

# --------------------------------------------------------------------------------------------------------------------------------------------------------------- Miaoudy 

@app.post("/blur", response_model=BlurResponse)
def blur(req: BlurRequest):
    header, b64data = req.image.split(",", 1)
    raw = base64.b64decode(b64data)

    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)

    blurred = blur_pii_and_faces(image)

    ok, buf = cv2.imencode(".png", blurred)
    out_b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return BlurResponse(image=f"data:image/png;base64,{out_b64}")


@app.get("/health")
def health():
    return {"ok": True}