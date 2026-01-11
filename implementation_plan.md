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
- Composite them **server-side** using AWS MediaConvert
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
│                         AWS Lambda (Orchestrator)                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   1. Triggered by S3 event (camera file uploaded)                       │
│   2. Checks if screen file exists                                       │
│   3. Creates MediaConvert job for compositing                           │
│   4. (Optional) Updates status in DynamoDB                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         AWS MediaConvert                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Input 1: {streamName}.mp4 (screen - full frame)                       │
│   Input 2: {streamName}_camera.webm (camera - PiP overlay)              │
│                                                                         │
│   Processing:                                                           │
│   - Screen as base layer (full frame)                                   │
│   - Camera as overlay (bottom-right, 15% of frame width)                │
│   - Audio from screen recording (includes mic)                          │
│                                                                         │
│   Output: {streamName}_composited.mp4                                   │
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

## Prerequisites

### AWS Services Required
- **S3**: Already configured (bucket: `com.knit.pipe-recorder-videos`)
- **Lambda**: For orchestrating the compositing workflow
- **MediaConvert**: For server-side video compositing
- **IAM**: Roles for Lambda and MediaConvert to access S3

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

## Phase 2: Server-Side Compositing with MediaConvert

**Goal**: Automatically composite screen + camera when both files are in S3.

### Step 2.1: Create MediaConvert IAM Role

Create an IAM role for MediaConvert with these permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject"
            ],
            "Resource": [
                "arn:aws:s3:::com.knit.pipe-recorder-videos/*"
            ]
        }
    ]
}
```

Trust relationship:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "mediaconvert.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```

### Step 2.2: Create Lambda Orchestrator

Create a Lambda function that triggers compositing:

```javascript
// Lambda function: compositeVideoTrigger
const AWS = require('aws-sdk');
const mediaConvert = new AWS.MediaConvert({ 
    endpoint: 'https://YOUR_MEDIACONVERT_ENDPOINT.mediaconvert.us-east-1.amazonaws.com'
});
const s3 = new AWS.S3();

const BUCKET = 'com.knit.pipe-recorder-videos';
const MEDIACONVERT_ROLE = 'arn:aws:iam::YOUR_ACCOUNT:role/MediaConvertRole';

exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event));
    
    // Get the uploaded file info
    const record = event.Records[0];
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    // Extract streamName from camera file: {streamName}_camera.webm
    if (!key.endsWith('_camera.webm')) {
        console.log('Not a camera file, skipping');
        return;
    }
    
    const streamName = key.replace('_camera.webm', '');
    const screenKey = `${streamName}.mp4`;
    const outputKey = `${streamName}_composited.mp4`;
    
    // Check if screen file exists
    try {
        await s3.headObject({ Bucket: BUCKET, Key: screenKey }).promise();
    } catch (err) {
        console.log('Screen file not found yet:', screenKey);
        // Could implement retry logic or SNS notification
        return;
    }
    
    console.log('Both files present, starting MediaConvert job');
    
    // Create MediaConvert job
    const jobSettings = {
        Role: MEDIACONVERT_ROLE,
        Settings: {
            Inputs: [
                {
                    // Screen recording (base layer)
                    FileInput: `s3://${BUCKET}/${screenKey}`,
                    AudioSelectors: {
                        "Audio Selector 1": {
                            DefaultSelection: "DEFAULT"
                        }
                    },
                    VideoSelector: {}
                },
                {
                    // Camera recording (overlay)
                    FileInput: `s3://${BUCKET}/${key}`,
                    VideoSelector: {}
                    // No audio from camera
                }
            ],
            OutputGroups: [
                {
                    Name: "File Group",
                    OutputGroupSettings: {
                        Type: "FILE_GROUP_SETTINGS",
                        FileGroupSettings: {
                            Destination: `s3://${BUCKET}/${streamName}_composited`
                        }
                    },
                    Outputs: [
                        {
                            ContainerSettings: {
                                Container: "MP4",
                                Mp4Settings: {}
                            },
                            VideoDescription: {
                                CodecSettings: {
                                    Codec: "H_264",
                                    H264Settings: {
                                        RateControlMode: "QVBR",
                                        QvbrSettings: {
                                            QvbrQualityLevel: 7
                                        },
                                        MaxBitrate: 5000000
                                    }
                                },
                                // Picture-in-Picture overlay
                                VideoPreprocessors: {
                                    ImageInserter: {
                                        InsertableImages: [
                                            {
                                                ImageInserterInput: `s3://${BUCKET}/${key}`,
                                                // Position: bottom-right, 15% of frame
                                                ImageX: 0,  // Will be calculated
                                                ImageY: 0,  // Will be calculated
                                                Layer: 1,
                                                Opacity: 100,
                                                Width: 15,  // 15% of output width
                                                Height: 0   // Maintain aspect ratio
                                            }
                                        ]
                                    }
                                }
                            },
                            AudioDescriptions: [
                                {
                                    CodecSettings: {
                                        Codec: "AAC",
                                        AacSettings: {
                                            Bitrate: 128000,
                                            CodingMode: "CODING_MODE_2_0",
                                            SampleRate: 48000
                                        }
                                    },
                                    AudioSourceName: "Audio Selector 1"
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    };
    
    try {
        const result = await mediaConvert.createJob(jobSettings).promise();
        console.log('MediaConvert job created:', result.Job.Id);
        return { jobId: result.Job.Id };
    } catch (err) {
        console.error('MediaConvert job failed:', err);
        throw err;
    }
};
```

**Note**: MediaConvert's ImageInserter is for static images. For video overlay (PiP), you need to use **Input Stitching** with **Overlay** settings. Here's the corrected approach:

```javascript
// Corrected MediaConvert job for video overlay
const jobSettings = {
    Role: MEDIACONVERT_ROLE,
    Settings: {
        Inputs: [
            {
                FileInput: `s3://${BUCKET}/${screenKey}`,
                AudioSelectors: {
                    "Audio Selector 1": { DefaultSelection: "DEFAULT" }
                },
                VideoSelector: {},
                VideoOverlays: [
                    {
                        Input: {
                            FileInput: `s3://${BUCKET}/${key}`,
                            VideoSelector: {}
                        },
                        Position: {
                            // Bottom-right corner, 15% width
                            Width: 15,
                            Height: 0,  // Maintain aspect ratio
                            XPosition: 83,  // 100 - 15 - 2 (margin)
                            YPosition: 83   // Similar for Y
                        }
                    }
                ]
            }
        ],
        OutputGroups: [
            {
                Name: "File Group",
                OutputGroupSettings: {
                    Type: "FILE_GROUP_SETTINGS",
                    FileGroupSettings: {
                        Destination: `s3://${BUCKET}/`
                    }
                },
                Outputs: [
                    {
                        NameModifier: `${streamName}_composited`,
                        ContainerSettings: {
                            Container: "MP4"
                        },
                        VideoDescription: {
                            CodecSettings: {
                                Codec: "H_264",
                                H264Settings: {
                                    RateControlMode: "QVBR",
                                    QvbrSettings: { QvbrQualityLevel: 7 }
                                }
                            }
                        },
                        AudioDescriptions: [
                            {
                                CodecSettings: {
                                    Codec: "AAC",
                                    AacSettings: {
                                        Bitrate: 128000,
                                        SampleRate: 48000
                                    }
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    }
};
```

### Step 2.3: Configure S3 Event Notification

In AWS Console or via CLI:

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

Also add Lambda permission:

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

### Test 3: MediaConvert Job

1. Check CloudWatch Logs for Lambda
2. Check MediaConvert console for job status
3. After job completes, verify `{streamName}_composited.mp4` exists in S3

### Test 4: End-to-End

1. Complete a full survey
2. Check Qualtrics embedded data for the composited URL
3. Wait 5-10 minutes
4. Verify video plays correctly with PiP overlay

---

## Phase 4: Production Deployment

### Checklist

- [ ] Deploy presigned URL Lambda + API Gateway
- [ ] Deploy compositing Lambda
- [ ] Create MediaConvert IAM role
- [ ] Configure S3 event notification
- [ ] Update client JavaScript files
- [ ] Push changes to GitHub (jsDelivr CDN)
- [ ] Test in Qualtrics preview
- [ ] Test full survey submission
- [ ] Implement retry logic in your video-reading system

### Monitoring

Set up CloudWatch alarms for:
- Lambda errors
- MediaConvert job failures
- S3 upload failures (via CloudTrail)

### Cost Estimates

At 10,000 recordings/day × 10 minutes each:

| Service | Usage | Cost/Month |
|---------|-------|------------|
| MediaConvert | 100,000 min × $0.015 | ~$45,000 |
| Lambda | ~10,000 invocations/day | ~$3 |
| S3 Storage | ~3TB (assuming 30MB/video) | ~$70 |
| S3 Requests | ~60,000 PUT/day | ~$30 |
| Data Transfer | Varies | Varies |

**Note**: MediaConvert costs can be reduced by:
- Using reserved pricing (40% discount)
- Using spot pricing for non-urgent jobs
- Optimizing output quality settings

---

## Alternative: Lambda + FFmpeg (Lower Cost)

For lower costs, you can use Lambda with FFmpeg layer instead of MediaConvert:

### Pros
- ~10x cheaper than MediaConvert
- More control over output

### Cons
- Lambda has 15-minute timeout
- Limited to 10GB memory
- Need to handle FFmpeg complexity

### Implementation

Use the `ffmpeg-lambda-layer` and run:

```bash
ffmpeg -i screen.mp4 -i camera.webm \
    -filter_complex "[0:v][1:v]overlay=W-w-20:H-h-20:shortest=1[outv]" \
    -map "[outv]" -map 0:a \
    -c:v libx264 -crf 23 -preset fast \
    -c:a aac -b:a 128k \
    output.mp4
```

This overlays the camera in the bottom-right corner with 20px margin.

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

### MediaConvert Job Fails

**Symptoms**: Job status is "ERROR"
**Causes**:
- Input file not found
- Codec not supported
- IAM permissions

**Solution**: Check CloudWatch Logs, verify input files exist

### Composited Video Missing

**Symptoms**: Final URL returns 404
**Causes**:
- MediaConvert job still processing
- Job failed silently

**Solution**: Add CloudWatch Events for MediaConvert job completion

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
│   └── compositeVideo/       # NEW: MediaConvert orchestrator
│       └── index.js
├── README.md
└── implementation_plan.md    # This file
```

---

## Summary

1. **Client changes**: Record camera separately with MediaRecorder, upload to S3
2. **Server changes**: Lambda triggers MediaConvert when camera file arrives
3. **URL strategy**: Set composited URL immediately; file appears after processing
4. **Your system**: Add retry logic for fetching videos (5-10 min delay)

This architecture eliminates client-side compositing, ensuring reliable video quality regardless of user's hardware.

