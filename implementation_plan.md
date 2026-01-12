# Implementation Plan: Server-Side Screen + Camera Compositing

## Overview

This document outlines the implementation plan for recording screen and camera separately on the client, then compositing them server-side. This solves the performance issues with client-side compositing on slower machines.

### Current Problem
- AddPipe's client-side screen + camera compositing is CPU/GPU intensive
- On Retina Macs and slower machines, the compositing fails
- Result: Corrupted videos with audio but no video, or extremely choppy camera overlay

### Solution
- Record screen and camera as **separate streams** on the client
- Upload both to S3
- Composite them **server-side** using one of several options (see Phase 2)
- Output the final video to a predictable URL

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser/Qualtrics)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────────────────┐         ┌─────────────────────┐               │
│   │   AddPipe SDK       │         │   MediaRecorder API │               │
│   │   (Screen Only)     │         │   (Camera Only)     │               │
│   └──────────┬──────────┘         └──────────┬──────────┘               │
│              │                               │                          │
│              ▼                               ▼                          │
│   Uploads to S3 via AddPipe      Uploads to S3 via Presigned URL        │
│   {streamName}.mp4               {streamName}_camera.webm               │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  Set Qualtrics Embedded Data:                                   │   │
│   │  {S3_BASE_URL}{streamName}_composited.mp4                       │   │
│   │  (File will exist after server processing)                      │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS S3                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Bucket: com.knit.pipe-recorder-videos                                 │
│                                                                         │
│   Files:                                                                │
│   ├── {streamName}.mp4           (screen recording from AddPipe)        │
│   ├── {streamName}_camera.webm   (camera recording from browser)        │
│   └── {streamName}_composited.mp4 (final output after processing)       │
│                                                                         │
│   S3 Event Notification ──────────────────────────────────────────┐     │
│   Trigger: ObjectCreated for *_camera.webm                        │     │
│                                                                   ▼     │
└───────────────────────────────────────────────────────────────────┼─────┘
                                                                    │
                              ┌─────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    SERVER-SIDE COMPOSITING                               │
│                    (Choose ONE of these options)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Option A: Remotion Lambda (React-based, runs on your AWS)             │
│   Option B: Shotstack / Creatomate (JSON API, managed service)          │
│   Option C: Editframe (HTML/CSS-based, managed service)                 │
│   Option D: AWS MediaConvert (managed, expensive)                       │
│   Option E: Self-hosted FFmpeg (cheapest, most setup)                   │
│                                                                         │
│   All options output to: {streamName}_composited.mp4                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Your Application                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   1. Reads video URL from Qualtrics embedded data                       │
│   2. Fetches video from S3                                              │
│   3. Implements retry logic (video may take 5-10 min to appear)         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Server-Side Options Comparison

| Option | Est. Cost (100K min/day) | Setup Effort | Pros | Cons |
|--------|--------------------------|--------------|------|------|
| **Remotion Lambda** | ~$500-2,000/mo | Medium | Runs on your AWS, React-based, very scalable | React learning curve, needs license |
| **Shotstack** | ~$10-20K/mo | Low | Simple JSON API, managed | Per-render pricing |
| **Creatomate** | ~$9-18K/mo | Low | Simple JSON API, good templates | Per-render pricing |
| **Editframe** | Contact for pricing | Low | HTML/CSS-based, parallel rendering | Newer service |
| **AWS MediaConvert** | ~$45,000/mo | Medium | Native AWS, reliable | Very expensive |
| **Self-hosted FFmpeg** | ~$500-2,500/mo | High | Cheapest, full control | Must manage infrastructure |

**Recommendation**: Start with **Remotion Lambda** (best value) or **Shotstack/Creatomate** (simplest API).

---

## Prerequisites

### Required for All Options
- **S3**: Already configured (bucket: `com.knit.pipe-recorder-videos`)
- **Lambda**: For orchestrating the compositing workflow (triggers processing)
- **IAM**: Roles for Lambda to access S3

### Existing Setup
- AddPipe account with S3 push configured
- Qualtrics survey with embedded JavaScript
- S3 bucket: `com.knit.pipe-recorder-videos`

### Tools Needed
- AWS CLI configured
- Node.js 18+ (for Lambda function)
- Access to AWS Console

---

## Phase 1: Client-Side Camera Recording

**Goal**: Record camera separately using MediaRecorder API while AddPipe records screen.

> ⚠️ **This phase is the same regardless of which server-side option you choose.**

### Step 1.1: Disable AddPipe's Camera PiP

Modify `qualtrics/question.js` to use AddPipe for screen-only:

```javascript
var pipeParams = { 
    size: { width: "100%", height: 510, }, 
    qualityurl: "avq/480p.xml",
    accountHash: "fb6878ab6bdc0a6bc55c2a6b3f695e05",
    eid: "KCfFkj", 
    mrt: 120, 
    avrec: 0,  // DISABLE camera recording in AddPipe
    sis: 0,
    srec: 1,   // Screen recording only
    mimetype: mimetype, 
    questionName: questionName, 
    payload: "${e://Field/ResponseID}", 
};
```

### Step 1.2: Add MediaRecorder for Camera

Create a new file `public/camera-recorder.js`:

```javascript
/**
 * Camera Recorder Module
 * Records camera separately from screen using MediaRecorder API
 */

var CameraRecorder = (function() {
    var mediaRecorder = null;
    var recordedChunks = [];
    var cameraStream = null;
    var isRecording = false;
    
    /**
     * Initialize camera stream
     * @returns {Promise<MediaStream>}
     */
    async function initCamera() {
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 360 },
                    frameRate: { ideal: 30 }
                },
                audio: false  // Audio comes from screen recording
            });
            return cameraStream;
        } catch (err) {
            console.error('Camera access error:', err);
            throw err;
        }
    }
    
    /**
     * Start recording camera
     */
    function startRecording() {
        if (!cameraStream) {
            console.error('Camera not initialized');
            return;
        }
        
        recordedChunks = [];
        
        // Use VP9 or VP8 codec for better compression
        var options = { mimeType: 'video/webm;codecs=vp9' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm;codecs=vp8' };
        }
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm' };
        }
        
        mediaRecorder = new MediaRecorder(cameraStream, options);
        
        mediaRecorder.ondataavailable = function(event) {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };
        
        mediaRecorder.start(1000);  // Collect data every second
        isRecording = true;
        console.log('Camera recording started');
    }
    
    /**
     * Stop recording and return blob
     * @returns {Promise<Blob>}
     */
    function stopRecording() {
        return new Promise((resolve, reject) => {
            if (!mediaRecorder || !isRecording) {
                reject(new Error('Not recording'));
                return;
            }
            
            mediaRecorder.onstop = function() {
                var blob = new Blob(recordedChunks, { type: 'video/webm' });
                isRecording = false;
                console.log('Camera recording stopped, blob size:', blob.size);
                resolve(blob);
            };
            
            mediaRecorder.stop();
        });
    }
    
    /**
     * Upload camera blob to S3
     * @param {Blob} blob - Camera recording blob
     * @param {string} streamName - AddPipe stream name for matching files
     * @param {string} presignedUrl - Presigned S3 URL for upload
     * @returns {Promise<string>} - Final S3 URL
     */
    async function uploadToS3(blob, streamName, presignedUrl) {
        console.log('Uploading camera recording to S3...');
        
        const response = await fetch(presignedUrl, {
            method: 'PUT',
            body: blob,
            headers: {
                'Content-Type': 'video/webm'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to upload camera recording: ' + response.status);
        }
        
        console.log('Camera recording uploaded successfully');
        return `${S3_BASE_URL}${streamName}_camera.webm`;
    }
    
    /**
     * Show camera preview in a container
     * @param {HTMLElement} container - Container element for preview
     */
    function showPreview(container) {
        if (!cameraStream) {
            console.error('Camera not initialized');
            return;
        }
        
        var video = document.createElement('video');
        video.srcObject = cameraStream;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.style.cssText = 'width: 100%; height: 100%; object-fit: cover; border-radius: 8px;';
        
        container.innerHTML = '';
        container.appendChild(video);
    }
    
    /**
     * Stop camera stream
     */
    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
    }
    
    /**
     * Check if currently recording
     * @returns {boolean}
     */
    function getIsRecording() {
        return isRecording;
    }
    
    // Public API
    return {
        initCamera: initCamera,
        startRecording: startRecording,
        stopRecording: stopRecording,
        uploadToS3: uploadToS3,
        showPreview: showPreview,
        stopCamera: stopCamera,
        isRecording: getIsRecording
    };
})();
```

### Step 1.3: Integrate with AddPipe Events

Modify `public/custom-secure.js` to sync camera recording with AddPipe:

```javascript
// Add these at the top of the file
var cameraBlob = null;
var cameraRecordingReady = false;

// In the loadPipe function, modify the event handlers:

recorderObject.btRecordPressed = function (recorderId) {
    try {
        console.log('btRecordPressed >>> ');
        startRecordingClicked();
        jQuery('#NextButton-custom').hide();
        isRecording = true;
        
        // START CAMERA RECORDING
        CameraRecorder.startRecording();
        
        intervalID = setInterval(getTime, 1000, recorderObject);
    } catch (err) {
        console.log(err.message);
    }
};

recorderObject.btStopRecordingPressed = async function (recorderId) {
    clearInterval(intervalID);
    
    var args = Array.prototype.slice.call(arguments);
    console.log('btStopRecordingPressed(' + args.join(', ') + ')');
    isRecording = false;
    
    // STOP CAMERA RECORDING
    try {
        cameraBlob = await CameraRecorder.stopRecording();
        cameraRecordingReady = true;
        console.log('Camera blob ready, size:', cameraBlob.size);
    } catch (err) {
        console.error('Failed to stop camera recording:', err);
    }
    
    stoppedVideo();
};

recorderObject.onSaveOk = async function (
    recorderId,
    streamName,
    streamDuration,
    cameraName,
    micName,
    audioCodec,
    videoCodec,
    fileType,
    videoId,
    audioOnly,
    location
) {
    console.log('onSaveOk - streamName:', streamName);
    
    // Upload camera recording if ready
    if (cameraRecordingReady && cameraBlob) {
        try {
            // Get presigned URL from your backend
            const presignedUrl = await getPresignedUrl(streamName + '_camera.webm');
            await CameraRecorder.uploadToS3(cameraBlob, streamName, presignedUrl);
            console.log('Camera upload complete');
        } catch (err) {
            console.error('Camera upload failed:', err);
        }
    }
    
    // Set the COMPOSITED URL (will exist after server processing)
    const compositedURL = `${S3_BASE_URL}${streamName}_composited.mp4`;
    updateEmbeddedData(compositedURL);
    
    validateVideo(recorderObject, location, streamName);
};
```

### Step 1.4: Add Presigned URL Endpoint

You need a backend endpoint that generates presigned S3 URLs. Here's an example Lambda function:

```javascript
// Lambda function: getPresignedUrl
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

exports.handler = async (event) => {
    const { filename } = JSON.parse(event.body);
    
    const params = {
        Bucket: 'com.knit.pipe-recorder-videos',
        Key: filename,
        Expires: 3600,  // 1 hour
        ContentType: 'video/webm'
    };
    
    const url = await s3.getSignedUrlPromise('putObject', params);
    
    return {
        statusCode: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify({ url })
    };
};
```

Deploy this behind API Gateway and update the client code:

```javascript
async function getPresignedUrl(filename) {
    const response = await fetch('https://your-api.execute-api.us-east-1.amazonaws.com/prod/presigned-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
    });
    const data = await response.json();
    return data.url;
}
```

---

## Phase 2: Server-Side Compositing

**Goal**: Automatically composite screen + camera when both files are in S3.

> 📋 **Choose ONE of the following options based on your needs.**

---

### Option A: Remotion Lambda (Recommended for Cost)

**Best for**: Maximum cost savings while maintaining quality and control.

**Documentation**: [remotion.dev/docs/lambda](https://www.remotion.dev/docs/lambda)

#### How It Works
1. Write video composition in React
2. Deploy Remotion to your AWS Lambda
3. Trigger composition when both files are in S3
4. Output composited video to S3

#### Estimated Cost
- ~$500-2,000/month at 100K minutes/day
- Requires [Remotion license](https://remotion.pro/license) for commercial use

#### Setup Steps

**Step A.1: Install Remotion**

```bash
npm init video -- --template=lambda
cd my-video
npm i
```

**Step A.2: Create Composition Component**

```tsx
// src/PipComposition.tsx
import { AbsoluteFill, Video, useVideoConfig } from 'remotion';

interface PipProps {
  screenVideoUrl: string;
  cameraVideoUrl: string;
}

export const PipComposition: React.FC<PipProps> = ({
  screenVideoUrl,
  cameraVideoUrl,
}) => {
  const { width, height } = useVideoConfig();
  
  // Camera overlay: bottom-right, 15% of frame width
  const camWidth = width * 0.15;
  const camHeight = camWidth * (9/16); // Assume 16:9 aspect ratio
  const margin = 20;
  
  return (
    <AbsoluteFill>
      {/* Screen recording - full frame */}
      <Video src={screenVideoUrl} />
      
      {/* Camera overlay - bottom right */}
      <div style={{
        position: 'absolute',
        right: margin,
        bottom: margin,
        width: camWidth,
        height: camHeight,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      }}>
        <Video 
          src={cameraVideoUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};
```

**Step A.3: Deploy to Lambda**

```bash
npx remotion lambda sites create src/index.ts --site-name=pip-compositor
npx remotion lambda functions deploy
```

**Step A.4: Trigger from Orchestrator Lambda**

```javascript
// Lambda function: compositeVideoTrigger (Remotion version)
const { renderMediaOnLambda, getRenderProgress } = require('@remotion/lambda');

const BUCKET = 'com.knit.pipe-recorder-videos';
const REMOTION_FUNCTION_NAME = 'remotion-render-function';
const REMOTION_SERVE_URL = 'https://your-remotion-site.s3.amazonaws.com/pip-compositor/index.html';

exports.handler = async (event) => {
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    if (!key.endsWith('_camera.webm')) {
        return { message: 'Not a camera file' };
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenUrl = `https://${BUCKET}.s3.amazonaws.com/${streamName}.mp4`;
    const cameraUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;
    
    const { renderId } = await renderMediaOnLambda({
        region: 'us-east-1',
        functionName: REMOTION_FUNCTION_NAME,
        serveUrl: REMOTION_SERVE_URL,
        composition: 'PipComposition',
        inputProps: {
            screenVideoUrl: screenUrl,
            cameraVideoUrl: cameraUrl,
        },
        codec: 'h264',
        outName: `${streamName}_composited.mp4`,
        // Output to your S3 bucket
        downloadBehavior: {
            type: 's3-output',
            bucketName: BUCKET,
            key: `${streamName}_composited.mp4`,
        },
    });
    
    return { renderId, streamName };
};
```

---

### Option B: Shotstack API

**Best for**: Simplicity, no infrastructure to manage.

**Documentation**: [shotstack.io/docs](https://shotstack.io/docs/guide/)

#### How It Works
1. Send JSON describing your video composition
2. Shotstack renders it on their infrastructure
3. Download or push to your S3

#### Estimated Cost
- ~$10-20K/month at your volume (contact for enterprise pricing)

#### Setup Steps

**Step B.1: Get API Key**

Sign up at [shotstack.io](https://shotstack.io) and get your API key.

**Step B.2: Trigger from Orchestrator Lambda**

```javascript
// Lambda function: compositeVideoTrigger (Shotstack version)
const fetch = require('node-fetch');

const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;
const SHOTSTACK_URL = 'https://api.shotstack.io/v1/render';
const BUCKET = 'com.knit.pipe-recorder-videos';

exports.handler = async (event) => {
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    if (!key.endsWith('_camera.webm')) {
        return { message: 'Not a camera file' };
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenUrl = `https://${BUCKET}.s3.amazonaws.com/${streamName}.mp4`;
    const cameraUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;
    
    // Shotstack API payload
    const payload = {
        timeline: {
            tracks: [
                // Camera overlay track (on top)
                {
                    clips: [
                        {
                            asset: {
                                type: 'video',
                                src: cameraUrl,
                            },
                            start: 0,
                            length: 'auto',
                            position: 'bottomRight',
                            offset: {
                                x: -0.02,  // 2% from right
                                y: 0.02,   // 2% from bottom
                            },
                            scale: 0.15,  // 15% of frame
                        }
                    ]
                },
                // Screen recording track (base layer)
                {
                    clips: [
                        {
                            asset: {
                                type: 'video',
                                src: screenUrl,
                            },
                            start: 0,
                            length: 'auto',
                        }
                    ]
                }
            ]
        },
        output: {
            format: 'mp4',
            resolution: 'hd',
            destinations: [
                {
                    provider: 's3',
                    options: {
                        bucket: BUCKET,
                        region: 'us-east-1',
                        key: `${streamName}_composited.mp4`,
                    }
                }
            ]
        }
    };
    
    const response = await fetch(SHOTSTACK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': SHOTSTACK_API_KEY,
        },
        body: JSON.stringify(payload),
    });
    
    const result = await response.json();
    return { renderId: result.response.id, streamName };
};
```

---

### Option C: Creatomate API

**Best for**: Similar to Shotstack, good template support.

**Documentation**: [creatomate.com/developers](https://creatomate.com/developers)

#### How It Works
1. Create a template in their editor (or use JSON)
2. Call API with your video URLs
3. Output to your S3

#### Estimated Cost
- ~$9-18K/month at your volume (slightly cheaper than Shotstack)

#### Setup Steps

**Step C.1: Get API Key**

Sign up at [creatomate.com](https://creatomate.com) and get your API key.

**Step C.2: Trigger from Orchestrator Lambda**

```javascript
// Lambda function: compositeVideoTrigger (Creatomate version)
const fetch = require('node-fetch');

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_URL = 'https://api.creatomate.com/v1/renders';
const BUCKET = 'com.knit.pipe-recorder-videos';

exports.handler = async (event) => {
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    if (!key.endsWith('_camera.webm')) {
        return { message: 'Not a camera file' };
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenUrl = `https://${BUCKET}.s3.amazonaws.com/${streamName}.mp4`;
    const cameraUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;
    
    // Creatomate API payload
    const payload = {
        source: {
            output_format: 'mp4',
            width: 1920,
            height: 1080,
            elements: [
                // Screen recording (base layer)
                {
                    type: 'video',
                    source: screenUrl,
                },
                // Camera overlay
                {
                    type: 'video',
                    source: cameraUrl,
                    x: '85%',  // Position from left
                    y: '85%',  // Position from top
                    width: '15%',
                    height: null,  // Maintain aspect ratio
                    border_radius: 8,
                }
            ]
        },
        // Optional: output directly to S3
        webhook_url: 'https://your-webhook.com/creatomate-complete',
    };
    
    const response = await fetch(CREATOMATE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
        },
        body: JSON.stringify(payload),
    });
    
    const result = await response.json();
    
    // Note: You'll need to download from Creatomate and upload to your S3
    // Or use their webhook to get the final URL
    return { renderId: result[0].id, streamName };
};
```

---

### Option D: Editframe

**Best for**: HTML/CSS-based composition, familiar web tech.

**Documentation**: [editframe.com/docs](https://editframe.com/docs/rendering/api)

#### How It Works
1. Create an HTML/CSS project that displays your videos
2. Bundle it as a tarfile
3. Upload to Editframe for rendering
4. They parallelize rendering across workers

#### Estimated Cost
- Contact for pricing

#### Setup Steps

**Step D.1: Create Video Project**

Create a directory with your composition:

```html
<!-- index.html -->
<!DOCTYPE html>
<html>
<head>
    <style>
        body { margin: 0; background: #000; }
        #screen { width: 100%; height: 100%; object-fit: contain; }
        #camera {
            position: absolute;
            bottom: 20px;
            right: 20px;
            width: 15%;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
    </style>
</head>
<body>
    <video id="screen" autoplay muted></video>
    <video id="camera" autoplay muted></video>
    
    <script>
        // RENDER_DATA is injected by Editframe
        const { screenUrl, cameraUrl } = RENDER_DATA;
        document.getElementById('screen').src = screenUrl;
        document.getElementById('camera').src = cameraUrl;
    </script>
</body>
</html>
```

**Step D.2: Trigger from Orchestrator Lambda**

```javascript
// Lambda function: compositeVideoTrigger (Editframe version)
const api = require('@editframe/api');

const EF_TOKEN = process.env.EDITFRAME_TOKEN;
const client = new api.Client(EF_TOKEN);
const BUCKET = 'com.knit.pipe-recorder-videos';

exports.handler = async (event) => {
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    if (!key.endsWith('_camera.webm')) {
        return { message: 'Not a camera file' };
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenUrl = `https://${BUCKET}.s3.amazonaws.com/${streamName}.mp4`;
    const cameraUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;
    
    // Bundle the render project
    const tarStream = await bundleRender({
        root: './pip-project',  // Your HTML/CSS project
        renderData: {
            screenUrl,
            cameraUrl,
        }
    });
    
    // Create and upload render
    const render = await api.createRender(client, { fps: 30 });
    await api.uploadRender(client, render.id, tarStream);
    
    // Wait for completion (or use webhooks)
    await api.getRenderProgress(client, render.id).whenComplete();
    
    // Download and upload to your S3
    const response = await api.downloadRender(client, render.id);
    // ... upload response.body to S3 as {streamName}_composited.mp4
    
    return { renderId: render.id, streamName };
};
```

---

### Option E: Self-Hosted FFmpeg

**Best for**: Maximum cost savings, full control.

#### How It Works
1. Deploy FFmpeg on EC2, Fly.io, or Hetzner
2. Process videos with FFmpeg CLI
3. Upload output to S3

#### Estimated Cost
- ~$500-2,500/month (infrastructure only)

#### Setup Steps

See the "Alternative: Lambda + FFmpeg" section below for the FFmpeg approach.

---

## Common: S3 Event Trigger

**All options** use the same S3 trigger to start processing:

### Configure S3 Event Notification

```bash
aws s3api put-bucket-notification-configuration \
    --bucket com.knit.pipe-recorder-videos \
    --notification-configuration '{
        "LambdaFunctionConfigurations": [
            {
                "LambdaFunctionArn": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:compositeVideoTrigger",
                "Events": ["s3:ObjectCreated:*"],
                "Filter": {
                    "Key": {
                        "FilterRules": [
                            {
                                "Name": "suffix",
                                "Value": "_camera.webm"
                            }
                        ]
                    }
                }
            }
        ]
    }'
```

Add Lambda permission:

```bash
aws lambda add-permission \
    --function-name compositeVideoTrigger \
    --statement-id s3-trigger \
    --action lambda:InvokeFunction \
    --principal s3.amazonaws.com \
    --source-arn arn:aws:s3:::com.knit.pipe-recorder-videos
```

---

## Phase 3: Testing

### Test 1: Client-Side Recording

1. Open Qualtrics survey in preview mode
2. Grant camera/screen permissions
3. Record for 30 seconds
4. Stop recording
5. Check browser console for:
   - "Camera recording started"
   - "Camera recording stopped, blob size: X"
   - "Camera upload complete"

### Test 2: S3 Files

After recording, check S3 bucket for:
- `{streamName}.mp4` (screen from AddPipe)
- `{streamName}_camera.webm` (camera from MediaRecorder)

### Test 3: Server-Side Processing

1. Check CloudWatch Logs for your orchestrator Lambda
2. Check the processing service (Remotion/Shotstack/etc.) for job status
3. After completion, verify `{streamName}_composited.mp4` exists in S3

### Test 4: End-to-End

1. Complete a full survey
2. Check Qualtrics embedded data for the composited URL
3. Wait 5-10 minutes
4. Verify video plays correctly with PiP overlay

---

## Phase 4: Production Deployment

### Checklist

- [ ] Deploy presigned URL Lambda + API Gateway
- [ ] Choose server-side option (Remotion/Shotstack/Creatomate/Editframe)
- [ ] Set up chosen service and get API keys
- [ ] Deploy compositing orchestrator Lambda
- [ ] Configure S3 event notification
- [ ] Update client JavaScript files
- [ ] Push changes to GitHub (jsDelivr CDN)
- [ ] Test in Qualtrics preview
- [ ] Test full survey submission
- [ ] Implement retry logic in your video-reading system

### Monitoring

Set up CloudWatch alarms for:
- Lambda errors
- Processing job failures
- S3 upload failures (via CloudTrail)

---

## Alternative: Lambda + FFmpeg (Lowest Cost)

For maximum cost savings, use Lambda with FFmpeg layer:

### Pros
- ~10x cheaper than managed services
- Full control over output

### Cons
- Lambda has 15-minute timeout (limits video length)
- Limited to 10GB memory
- Need to handle FFmpeg complexity

### Implementation

**Step 1: Create Lambda with FFmpeg Layer**

Use a pre-built FFmpeg layer or build your own:
- [ffmpeg-lambda-layer](https://github.com/serverlesspub/ffmpeg-aws-lambda-layer)

**Step 2: Lambda Function**

```javascript
// Lambda function: compositeVideoFFmpeg
const { execSync } = require('child_process');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const fs = require('fs');

const BUCKET = 'com.knit.pipe-recorder-videos';

exports.handler = async (event) => {
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    if (!key.endsWith('_camera.webm')) {
        return { message: 'Not a camera file' };
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenKey = `${streamName}.mp4`;
    const outputKey = `${streamName}_composited.mp4`;
    
    // Download files to /tmp
    const screenPath = '/tmp/screen.mp4';
    const cameraPath = '/tmp/camera.webm';
    const outputPath = '/tmp/output.mp4';
    
    // Download screen
    const screenData = await s3.getObject({ Bucket: BUCKET, Key: screenKey }).promise();
    fs.writeFileSync(screenPath, screenData.Body);
    
    // Download camera
    const cameraData = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    fs.writeFileSync(cameraPath, cameraData.Body);
    
    // Run FFmpeg - overlay camera in bottom-right corner
    const ffmpegCmd = `ffmpeg -y -i ${screenPath} -i ${cameraPath} \
        -filter_complex "[1:v]scale=iw*0.15:-1[cam];[0:v][cam]overlay=W-w-20:H-h-20:shortest=1[outv]" \
        -map "[outv]" -map 0:a \
        -c:v libx264 -crf 23 -preset fast \
        -c:a aac -b:a 128k \
        ${outputPath}`;
    
    execSync(ffmpegCmd);
    
    // Upload result
    const outputData = fs.readFileSync(outputPath);
    await s3.putObject({
        Bucket: BUCKET,
        Key: outputKey,
        Body: outputData,
        ContentType: 'video/mp4',
    }).promise();
    
    // Clean up
    fs.unlinkSync(screenPath);
    fs.unlinkSync(cameraPath);
    fs.unlinkSync(outputPath);
    
    return { success: true, outputKey };
};
```

---

## Troubleshooting

### Camera Recording Fails

**Symptoms**: Camera blob is empty or null
**Causes**:
- Browser doesn't support MediaRecorder
- Camera permissions denied
- Camera already in use by AddPipe

**Solution**: Ensure AddPipe is set to `avrec: 0` (screen only)

### Upload Fails

**Symptoms**: "Failed to upload camera recording" error
**Causes**:
- Presigned URL expired
- CORS configuration
- Network issues

**Solution**: Check CORS on S3 bucket, increase presigned URL expiry

### Processing Job Fails

**Symptoms**: Job status is "ERROR" or timeout
**Causes**:
- Input file not found
- Codec not supported
- IAM permissions
- Video too long (for Lambda)

**Solution**: Check logs for specific error, verify input files exist

### Composited Video Missing

**Symptoms**: Final URL returns 404
**Causes**:
- Processing still in progress
- Job failed silently

**Solution**: Add webhook/polling to confirm job completion

---

## File Structure After Implementation

```
pipe-screen-sharing/
├── public/
│   ├── custom-css.css
│   ├── custom-secure.js      # Modified for camera sync
│   └── camera-recorder.js    # NEW: MediaRecorder module
├── qualtrics/
│   ├── question.html
│   └── question.js           # Modified: avrec: 0
├── lambda/
│   ├── getPresignedUrl/      # NEW: Presigned URL generator
│   │   └── index.js
│   └── compositeVideo/       # NEW: Orchestrator (choose your option)
│       └── index.js
├── remotion/                  # If using Remotion
│   └── src/
│       └── PipComposition.tsx
├── README.md
└── implementation_plan.md    # This file
```

---

## Summary

1. **Phase 1 (Client)**: Record camera separately with MediaRecorder, upload to S3
2. **Phase 2 (Server)**: Choose your compositing service:
   - **Remotion Lambda**: Best value (~$500-2K/mo)
   - **Shotstack/Creatomate**: Simplest API (~$10-20K/mo)
   - **Editframe**: HTML/CSS-based (contact for pricing)
   - **FFmpeg on Lambda**: Cheapest (~$3-5K/mo)
3. **URL strategy**: Set composited URL immediately; file appears after processing
4. **Your system**: Add retry logic for fetching videos (5-10 min delay)

This architecture eliminates client-side compositing, ensuring reliable video quality regardless of user's hardware.

---

## Next Steps

1. **Decide on server-side option** based on budget and complexity tolerance
2. **Implement Phase 1** (client-side changes - same for all options)
3. **Set up chosen compositing service**
4. **Test end-to-end**
5. **Deploy to production**
