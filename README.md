# Screen Recording Video Question for Qualtrics

This repository contains the custom code required to enable **Screen + Camera** recording questions within a Qualtrics survey. It utilizes the [AddPipe](https://addpipe.com/) recording client to capture user feedback via microphone, webcam, and screen sharing, automatically uploading the result to an S3 bucket and saving the URL back to Qualtrics.

## Features

* **Screen & Camera Recording:** Captures both the user's screen and their webcam/microphone simultaneously.
* **Mobile Device Blocking:** Automatically detects mobile or tablet devices and blocks access (as screen recording APIs are desktop-only), guiding users to switch to a desktop computer.
* **Custom UI:** Replaces the default recorder interface with a custom "Selfie" permission modal and instruction step.
* **Validation:** Enforces minimum recording duration (default: 30 seconds).
* **S3 Integration:** Videos are uploaded directly to a configured S3 bucket, and the file URL is saved to a Qualtrics Embedded Data field.

## Repository Structure

```text
.
├── public/
│   ├── custom-css.css          # Styles for the modals, recorder, and custom buttons
│   └── custom-secure.js        # Core logic: AddPipe init, event handling, mobile check, and validation
└── qualtrics/
    ├── question.html           # HTML structure for the question (modals, container divs)
    └── question.js             # Qualtrics JavaScript API integration (config & initialization)

```

## Setup Instructions

To use this in a Qualtrics survey, you will need to copy the contents of these files into the specific "Question" areas within the Qualtrics Survey Builder.

**Note:** The CSS and JavaScript files (`custom-css.css` and `custom-secure.js`) are hosted via [jsDelivr CDN](https://www.jsdelivr.com/) to avoid browser ORB (Opaque Response Blocking) issues. The HTML file references these files using jsDelivr URLs. If you fork this repository, update the URLs in `question.html` to point to your repository:

```html
<!-- CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/YOUR_USERNAME/pipe-screen-sharing@master/public/custom-css.css" />

<!-- JavaScript -->
<script type="text/javascript" src="https://cdn.jsdelivr.net/gh/YOUR_USERNAME/pipe-screen-sharing@master/public/custom-secure.js"></script>
```

**Why jsDelivr?** GitHub's raw URLs serve files with incorrect MIME types (`text/plain` instead of `text/css` or `application/javascript`), which causes browsers to block them due to ORB security policies. jsDelivr properly serves files with correct MIME types and CORS headers.

### 1. Create Question

Create a **Text/Graphic** question (or a standard Text Entry question if you prefer to hide the input box manually).

### 2. Configure IDs (Crucial Step)

Each video question must have a unique ID (e.g., `VQ1`, `VQ2`, `VQ3`) to prevent conflicts and ensure the video URL is saved to the correct variable.

**A. In `qualtrics/question.html`:**
Find the main container div and ensure the `id` matches your specific question identifier.

```html
<div id="VQ1"></div>

<div id="VQ2"></div>

```

**B. In `qualtrics/question.js`:**
Update the configuration variables at the very top of the file to match the ID you set in the HTML.

```javascript
// MUST match the <div id="..."> in your HTML
var questionName = "VQ1"; 

// The Qualtrics Embedded Data field where the final URL will be saved
var videoURL = "VQ1_pipe_url"; 

```

### 3. Add HTML

1. Open `qualtrics/question.html`.
2. In Qualtrics, click the question text area and select **HTML View**.
3. Paste the code (ensure you updated the `<div id="...">` as per step 2).

### 4. Add JavaScript

1. Open `qualtrics/question.js`.
2. In Qualtrics, click the **JavaScript** option for the question.
3. Paste the code inside the `Qualtrics.SurveyEngine.addOnload` function.
* *Reminder:* Ensure `questionName` and `videoURL` are updated for this specific question instance.



## Embedded Data Requirement

For every video question you create, you must define a corresponding **Embedded Data** field in your **Survey Flow** (usually at the very beginning of the flow).

If your JS has `var videoURL = "VQ1_pipe_url";`, you must create an embedded data field named `VQ1_pipe_url` in Qualtrics. This is where the script will paste the S3 link to the user's video.

| Question ID | JS Variable (`videoURL`) | Qualtrics Embedded Data Field |
| --- | --- | --- |
| VQ1 | `"VQ1_pipe_url"` | `VQ1_pipe_url` |
| VQ2 | `"VQ2_pipe_url"` | `VQ2_pipe_url` |
| VQ3 | `"VQ3_pipe_url"` | `VQ3_pipe_url` |

## Configuration & Mobile Logic

The core configuration happens in `qualtrics/question.js` inside the `pipeParams` object:

```javascript
var pipeParams = { 
    // ...
    sis: 0,                           // Skip Initial Screen (0 = show menu to select Screen Rec)
    srec: 1,                          // Enable Screen Recording
    // ...
};

```

The system uses `navigator.userAgent` in `question.js` (via the `checkDeviceAndBlock()` function) to detect mobile devices.

* **Behavior:** Hides the "Grant Access" button and displays a "Desktop Computer Required" error message.
* **Reason:** The `getDisplayMedia` API (required for screen sharing) is not supported on mobile browsers.

## Dependencies

This project relies on the following external libraries (loaded via CDN in the HTML):

* **AddPipe 2.0 SDK:** For recording functionality.
* **jQuery:** For DOM manipulation.
* **Bootstrap JS:** For modal functionality.
* **jQuery Modal:** For the custom permission/instruction popups.