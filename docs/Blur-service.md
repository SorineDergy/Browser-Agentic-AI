# Python Blur Service documentation

## Packages:

- base64 -> encodes binary data into ASCII
- math -> math functions
- re -> provides a set of tools for working with regex (regular expressions)
- Counter, from collections -> counting stuff
- cv2 -> libary for image processing (used for blurring)
- mediapipe -> A lightweight and easy too implement vision model for face detection in images with bounding
- pytesseract -> A python wrapper for Google's Tesseract OCR engine that extracts text from images
- FastAPI, from fastapi -> useful for configuring, building and running web applications
- CORSMiddleware, from fastapi.middleware.cors -> lets us handle Cross origin resource sharing, allows FastAPI to safely accept requests from a frontend hosted on a different domain, port or protocol
- Output, from pytesseract -> provides a helper class used to change the format and data type of the OCR results returned by the functions
- uvicorn[standard] -> used to open port 8788 and listens for incoming TCP connections, speaks the HTTP protocol and hands each incoming request off to FastAPI


# IMPORTANT

## PYTESSERACT library only holds the python wrapper, NOT the Tesseract engine. You MUST install the Tesseract OCR engine software on your operating system


Debian based distrobutions: ```apt install tesseract-ocr```

<br>

Arch based distrobutions: ```pacman -S tesseract tesseract-data-eng```
<br>
Windows: ```https://tesseract-ocr.github.io/tessdoc/Installation.html```
<br>
MacOS: ```brew install tesseract```
<br>

# Noteworthy stuff:

## Uvicorn:
while this library is in the requirments.txt, its not directly imported into the python script as the relationship runs the other way, as in uvicorn imports the file instead of the file importing.

To start the service: ```uvicorn blur_server:app --port 8788``` in ```blur_service\```
-# dont forget too install the dependencies in the folder first! ```pip install -r requirments.txt```

## Regular Expressions (REGEX):
Regex is used for pattern based detection for text acquired from the text extracted from the image

PII_PATTERNS: hold the regex information for Email, Phone, SSN/ID and Credit card.
API_KEY_PATTERNS: Hold all known API formats from major providers, add more as you find more standard formats from more providers.

## Luhn Algorithm
This is a simple checksum formula used to validate identification numbers like Credit card numbers, IMEI and goverment IDs.
Works for all credit cards globally under the ISO/IEC 7812-1 Standard. 
National ID systems are independently managed by sovergin goverments, so this will only work for specific countries 
Examples: Canada's "Canadian Social Insurance Numbers (SIN)", South African National ID numbers, Sweden's "Personnummer" or Personal Identity Numbers etc

## Shanon Entropy
Shannon entropy measures the average uncertainty, suprise or the amount of info needed to describe the outcome of a random variable.
This is used in our script too catch generic APIs and secrets/tokens.
(Threshold needs to be finetuned against real examples)

## Name Detection with Spacy
This feature is currently disabled as Names are very hard to filter, impossible with Regex and even trained models have a hard time detecing names consistently. A future feature to be implemented.


