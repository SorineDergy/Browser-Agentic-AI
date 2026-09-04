# Python Blur Service documentation

## Packages:

- base64 -> encodes binary data into ASCII
- math -> mathematical functions
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
<br>
dont forget too install the dependencies in the folder first! ```pip install -r requirments.txt```
<br>

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


# Future additional Implementations:
## India's goverment ID system:
India relies on multiple algorithms for their different identifications.
### Aadhaar (National Digital ID):
first 11 digits of the number are completely random.
12th Digit serves as the checksum, calculated by the "Verhoeff algorithm".
### PAN (Permanent Account Number - Income Tax):
The PAN is a 10-character alphanumeric string structured in a strict format (e.g., ABCDE1234F). The first 5 characters are letters, the next 4 are sequential numbers, and the 10th character is an alphabetic check digit.
The check digit is calculated by assigning specific numerical weights to the positions of the first 9 characters, multiplying them by assigned values for each letter/digit, and applying a custom modulus formula to generate the final verifying letter.(?)
### Voter ID/EPIC (Electors Photo Identity Card):
The Election Commission of India (ECI) uses a 10-character alphanumeric system. The first 3 characters are an alphabetic functional code designating the Electoral Registration Office, followed by a 7-digit unique sequential number. It does not utilize a mathematical validation checksum like Aadhaar; instead, it relies on strict formatting rules and centralized database lookups

## Name Detection with SpaCy
This feature is currently disabled as Names are very hard to filter, impossible with Regex and even trained models have a hard time detecing names consistently. A future feature to be implemented when everything else works.

## Specific goverment IDs from different countries that also use their own algorithms(?) Would Time complexity be too high for this(?)

