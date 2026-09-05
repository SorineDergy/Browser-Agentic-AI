"""
test_blur.py — send a local image to the blur service and save the result.

Usage:
    python test_blur.py path/to/your/test_image.jpg

Put a test image somewhere with a face in it and/or some visible text
containing a fake email/phone number, and check the output image to see
if those regions actually got blurred.
"""

import base64
import sys

import requests

BLUR_SERVER_URL = "http://localhost:8788/blur"


def main():
    if len(sys.argv) != 2:
        print("Usage: python test_blur.py path/to/image.jpg")
        sys.exit(1)

    image_path = sys.argv[1]

    with open(image_path, "rb") as f:
        raw_bytes = f.read()

    b64 = base64.b64encode(raw_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"

    print(f"Sending {image_path} ({len(raw_bytes)} bytes) to {BLUR_SERVER_URL} ...")
    response = requests.post(BLUR_SERVER_URL, json={"image": data_url})

    if response.status_code != 200:
        print(f"Request failed: {response.status_code}")
        print(response.text)
        sys.exit(1)

    result_data_url = response.json()["image"]
    _, b64_out = result_data_url.split(",", 1)
    out_bytes = base64.b64decode(b64_out)

    output_path = "blurred_output.png"
    with open(output_path, "wb") as f:
        f.write(out_bytes)

    print(f"Done. Saved blurred result to {output_path} — open it and check.")


if __name__ == "__main__":
    main()