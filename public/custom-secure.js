var isRecording = false;
var objectValue = {};
var defaultThumbnail = 'https://d2kltgp8v5sml0.cloudfront.net/templates/svg/gallary.svg';
var streamTime = '';
var recorderObjectGlobal;
var isBackTOcamera = false;
var isSocketOpen = false;
var intervalID;
var gallaryCss = 'display: grid; right:7px;';
var stream;
var S3_BASE_URL = 'https://s3.us-east-1.amazonaws.com/com.knit.pipe-recorder-videos/';

/**
 * Skips question validation based on validationDetails.
 */
function skipQuestionValidation() {
  console.log('Validate Video::', validationDetails);
  if (validationDetails.hasOwnProperty('required') && validationDetails.required) {
    jQuery('#NextButton-custom').hide();
  } else {
    jQuery('#NextButton-custom').show();
  }
}

/**
 * Loads Pipe recorder and sets up event handlers.
 * @param {string} question_name
 * @param {object} pipeParams
 */
const loadPipe = async function (question_name, pipeParams) {
  skipQuestionValidation();
  console.log('questionName::', questionName);
  jQuery('#pipeDownload-' + questionName).hide();
  PipeSDK.insert(question_name, pipeParams, function (recorderObject) {
    /**
     * Handler for when recorder is ready to record.
     */
    recorderObject.onReadyToRecord = async function (recorderId, recorderType) {
      jQuery('.pipeTimer').hide();
    };

    /**
     * Handler for record button pressed.
     */
    recorderObject.btRecordPressed = function (recorderId) {
      try {
        console.log('btRecordPressed >>> ');
        startRecordingClicked();
        jQuery('#NextButton-custom').hide();
        isRecording = true;
        
        intervalID = setInterval(getTime, 1000, recorderObject);
      } catch (err) {
        console.log(err.message);
      }
    };

    /**
     * Handler for stop recording button pressed.
     */
    recorderObject.btStopRecordingPressed = function (recorderId) {
      clearInterval(intervalID);

      var args = Array.prototype.slice.call(arguments);
      console.log('btStopRecordingPressed(' + args.join(', ') + ')');
      isRecording = false;
      stoppedVideo();
    };

    /**
     * Handler for playback complete event.
     */
    recorderObject.onPlaybackComplete = function (recorderId, recorderObject) {
      playBackPauseEvent(recorderId, recorderObject);
    };

    /**
     * Handler for pause button pressed.
     */
    recorderObject.btPausePressed = function (recorderId) {
      playBackPauseEvent(recorderId, recorderObject);
      showGallary();
    };

    /**
     * Handler for save ok event.
     */
    recorderObject.onSaveOk = function (
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
      validateVideo(recorderObject, location, streamName);
    };

    /**
     * Handler for video upload success event.
     */
    recorderObject.onVideoUploadSuccess = function (
      recorderId,
      filename,
      filetype,
      videoId,
      audioOnly,
      location
    ) {
      var args = Array.prototype.slice.call(arguments);
      console.log('onVideoUploadSuccess(' + args.join(', ') + ')');
      console.log(
        'setEmbeddedDataToQuestion >>>>>> >>>>> >>>>onVideoUploadSuccess',
        recorderId,
        filename,
        filetype,
        videoId,
        location,
        recorderObject
      );
      jQuery('#' + recorderId).attr('style', 'height:120px !important');
      jQuery('#NextButton-custom').show();
    };

    /**
     * Handler for play button pressed.
     */
    recorderObject.btPlayPressed = function (recorderId) {
      playVideoEvent();
    };
  });
};

/**
 * Handles retake logic and UI reset.
 */
function retake() {
  console.log('Retake---');
  jQuery('#pipeDownload-' + questionName).hide();
  try {
    this.recorderObjectGlobal.pause();
  } catch (err) {}
  skipQuestionValidation();
  jQuery('#SkinContent #Buttons').hide();
  jQuery('.retake-button').remove();
  jQuery('.pipeTimer').hide();
  jQuery('.pipeTimer-custom').hide();
  jQuery('#pipeRec-' + questionName).show();
  jQuery('#pipePlay-' + questionName).attr('style', 'display: none;');
  jQuery('.back-to-camera').remove();
  jQuery('#time-span').remove();
  jQuery('#pipeMenu-' + questionName).append(
    '<button class="play-custom-btn"  id="time-span" onClick="playVideoCustom()" ><img src="' +
	defaultThumbnail +
      '"></button>'
  );
  jQuery('.play-custom-btn').append('<span>' + Math.round(streamTime) + ' Sec</span>');
  jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'display:none !important');
}

/**
 * Shows the video gallery UI.
 */
function showGallary() {
  console.log('Show Gallary--');
  jQuery('#pipeDownload-' + questionName).hide();
  jQuery('#time-span').remove();
  jQuery('.pipeTimer-custom').hide();
  jQuery('.pipeTimer').show();
  if (isBackTOcamera) {
    jQuery('#pipeMenu-' + questionName).append(
      '<button class="play-custom-btn"  id="time-span" onClick="playVideoCustom()" ><img src="' +
	  defaultThumbnail +
        '"></button>'
    );
    jQuery('.play-custom-btn').append('<span>' + Math.round(streamTime) + ' Sec</span>');
    jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'opacity:0 !important');
  } else {
    jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'opacity:1 !important');
  }
  isBackTOcamera = false;
}

/**
 * Plays the custom video.
 */
function playVideoCustom() {
  console.log('playVideoCustom--');
  jQuery('.pipeTimer-custom').hide();
  jQuery('.pipeTimer').attr('style', 'display: block !important;');
  jQuery('.pipeTimer').show();
  jQuery('#time-span').remove();
  recorderObjectGlobal.playVideo();
}

/**
 * Handles UI when video is stopped.
 */
function stoppedVideo() {
  jQuery('#pipePlay-' + questionName).show();
  jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'opacity:0 !important');
}

/**
 * Handles play video event and UI update.
 */
function playVideoEvent() {
  isBackTOcamera = false;
  jQuery('#time-span').remove();
  jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'opacity:1 !important');
  jQuery('#pipeMenu-' + questionName).append(
    '<button class="back-to-camera" onClick="backToCamera()"><img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/camera-with-bg.png"><span>Back to Camera</span></button>'
  );
  jQuery('.pipeTimer').show();
  jQuery('#pipeRec-' + questionName).hide();
  jQuery('#pipePlay-' + questionName).attr('style', 'display: block;right: auto;');
}

/**
 * Handles back to camera event and UI reset.
 */
function backToCamera() {
  jQuery('.time-span').remove();
  jQuery('.pipeTimer').attr('style', 'display: none !important; ');
  jQuery('.pipeTimer-custom').empty().append('00:00');
  jQuery('.pipeTimer-custom').show();
  jQuery('.pipeTimer').hide();
  isBackTOcamera = true;
  this.recorderObjectGlobal.pause();
  retake();
}

/**
 * Handles modal retake event.
 */
function modalRetake() {
  jQuery.modal.close();
  retake();
}

/**
 * Moves to the next question.
 */
function nextQuestion() {
  jQuery.modal.close();
  document.querySelector('.NextButton').click();
}

/**
 * Handles playback pause event.
 * @param {string} recorderId
 * @param {object} recorderObject
 */
function playBackPauseEvent(recorderId, recorderObject) {
  jQuery('#pipePlay-' + questionName + ' svg').attr('style', 'opacity:1 !important');
}

/**
 * Closes the modal.
 */
function modalClose() {
  jQuery.modal.close();
}

/**
 * Handles start recording click event and UI update.
 */
function startRecordingClicked() {
  retake();
  jQuery('#pipeMenu-' + questionName).append(
    '<div class="pipeTimer-custom" style="left: 121px; color: rgb(51, 68, 85);">00:00</div>'
  );
  jQuery('.pipeTimer-custom').show();
  jQuery('#time-span').remove();
}

/**
 * Requests camera and audio access (video and audio).
 */
function getCamAccess() {
  console.log('getCamAccess >>> Grant Acess');
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        jQuery.modal.close();
        jQuery('#recordInstruction').modal();
        loadPipe(questionName, pipeParams);
        var sheet = document.createElement('style');
        sheet.innerHTML =
          '#pipeMenu-' +
          questionName +
          '{height:170px!important;background-color:#f6f3e6!important;display:flex;justify-content:center;align-items:center;width: 100% !important;}#pipeVrec-' +
          questionName +
          ',#' +
          questionName +
          '{height:auto!important}#pipeRec-' +
          questionName +
          '{text-align:center}#pipeClickPowered-' +
          questionName +
          '{display:none!important}#pipePlay-' +
          questionName +
          ' svg{fill:#F56A6A;border:7px solid #fff;border-radius:50%;padding:10px}#pipePlay-' +
          questionName +
          '{position:absolute;bottom:39px;display:none;right: 5%;}#pipeVideoInput-' +
          questionName +
          '{border-radius: 8px !important}.retake-button{border: 1px solid #fff; bottom: 68px; left: 43px; background: #12988A6E; width: 46px; height: 46px; border-radius: 50%; position: absolute;}.pipeTimer{display:none !important}';
        document.body.appendChild(sheet);
      })
      .catch((err) => {
        console.log('u got an error:' + err);
        fetch('https://api.ipify.org?format=json')
          .then((response) => response.json())
          .then((responseData) => {
            handleAPiCallForDeviceError(responseData.ip, err.toString());
          })
          .catch((error) => {
            handleAPiCallForDeviceError(null, error.toString());
            console.error('Error fetching IP address:', error);
          });
      });
  } else {
    // Fallback for browsers with different getUserMedia impl
    jQuery.modal.close();
    jQuery('#recordInstruction').modal();
    loadPipe(questionName, pipeParams);
    var sheet = document.createElement('style');
    sheet.innerHTML =
      '#pipeMenu-' +
      questionName +
      '{height:170px!important;background-color:#f6f3e6!important;display:flex;justify-content:center;align-items:center;width: 100% !important;}#pipeVrec-' +
      questionName +
      ',#' +
      questionName +
      '{height:auto!important}#pipeRec-' +
      questionName +
      '{text-align:center}#pipeClickPowered-' +
      questionName +
      '{display:none!important}#pipePlay-' +
      questionName +
      ' svg{fill:#F56A6A;border:7px solid #fff;border-radius:50%;padding:10px}#pipePlay-' +
      questionName +
      '{position:absolute;bottom:39px;display:none;right: 5%;}#pipeVideoInput-' +
      questionName +
      '{border-radius: 8px !important}.retake-button{border: 1px solid #fff; bottom: 68px; left: 43px; background: #12988A6E; width: 46px; height: 46px; border-radius: 50%; position: absolute;}.pipeTimer{display:none !important}';
    document.body.appendChild(sheet);
  }
}

/**
 * Handles API call for device error logging.
 * @param {string|null} IpAddress
 * @param {string} errorMessage
 */
function handleAPiCallForDeviceError(IpAddress, errorMessage) {
  const url = 'https://api-prd.goknit.com/api/v1/prd/piperecorder/error';
  const data = {
    question_id: questionName,
    url: window.location.href,
    metadata: {
      IpAddress: IpAddress,
      errorMessage: errorMessage,
    },
  };
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
  fetch(url, options)
    .then((response) => {
      console.log('Response:', response);
    })
    .catch((error) => {
      console.error('Error', error);
    });
}


/**
 * Validates the recorded video and updates the UI accordingly.
 * @param {object} recorderObject
 * @param {string} location
 * @param {string} streamName
 */
function validateVideo(recorderObject, location, streamName) {
  console.log('ValidateVideo >>>> ', recorderObject);
  const countDefined = (arr = []) => {
    let filtered;
    filtered = arr.filter((el) => {
      return el !== undefined;
    });
    const { length } = filtered;
    return length;
  };
  var sucessModalDetails = '';

  jQuery('#record-title').empty();
  jQuery('#image-sucess').empty();
  jQuery('#result').empty();

  var isError = false;
  this.recorderObjectGlobal = recorderObject;
  if (validationDetails.hasOwnProperty('min_streamtime')) {
    if (recorderObject.getStreamTime() < validationDetails.min_streamtime) {
      isError = true;
      sucessModalDetails +=
        '<li > <img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/false.svg" style="margin-right:5px;">Record a  <span>' + validationDetails.min_streamtime + ' sec or longer </span> video</li>';
    } else {
      sucessModalDetails +=
        '<li > <img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/true.svg" style="margin-right:5px;">Record a  <span>' + validationDetails.min_streamtime + ' sec or longer </span> video</li>';
    }
  }

  jQuery('#time-span').remove();
  streamTime = recorderObject.getStreamTime();
  if (isError) {
    jQuery('#next-button-modal').remove();
    jQuery('#SkinContent #Buttons').hide();
    jQuery('.retake-previous').remove();

    jQuery('#record-title').append('Oops!');
    jQuery('#image-sucess').append(
      ' <img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/validation_error.gif" style="margin-right: 5px;">'
    );
    jQuery('#result').append("<li style='font-size:15px;padding-left:5px;'>Your video didn't meet our criteria</li>");
    jQuery('#result').append(sucessModalDetails);
    jQuery('#result').append(
      '<button class="retake-text-btn" onClick="modalRetake()"><img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/Group+31.svg" data-image-state="ready">Retake</button>'
    );
    jQuery('#error').modal({
      escapeClose: false,
      clickClose: false,
      showClose: false,
    });
  } else {
    console.log('streamName::', streamName);
    const URL = `${S3_BASE_URL}${streamName}.mp4`;
    updateEmbeddedData(URL);
    jQuery('#NextButton-custom').show();
    jQuery('#next-button-modal').remove();
    jQuery('.retake-button').remove();
    jQuery('#record-title').append('Video Submitted!');
    jQuery('#pipeMenu-' + questionName).append(
      '<button class="retake-button" onClick="retake()"><img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/Group+33.svg"></button>'
    );
    jQuery('#pipeMenu-' + questionName).append(
      '<button class="play-custom-btn"  id="time-span" onClick="playVideoCustom()" ><img src="' +
	  defaultThumbnail +
        '"></button>'
    );
    jQuery('.play-custom-btn').append('<span>' + Math.round(recorderObject.getStreamTime()) + ' Sec</span>');
    jQuery('#image-sucess').append(
      '<img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/Success_animation_confetti.gif">'
    );
    sucessModalDetails = 'Your feedback was recorded successfully! You can move on to our next question.';
    jQuery('#result').append(sucessModalDetails);
    jQuery('.retake-previous').remove();
    jQuery('#error').append(
      '<button class="retake-previous"  onClick="modalRetake()"><img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/Group+34.svg"><span>Retake <br>Previous question</span></button>'
    );
    jQuery('#error').append(
      '<div id="next-button-modal"  class="textRight"><button class="next-button" onClick="nextQuestion()"> Next Question<img src="https://d2kltgp8v5sml0.cloudfront.net/templates/svg/next.svg"></button> </div>'
    );
    jQuery('#error').modal({
      escapeClose: true,
      clickClose: true,
      showClose: true,
    });
  }
}

/**
 * Updates the timer UI with the current stream time.
 * @param {object} recorderObject
 */
function getTime(recorderObject) {
  jQuery('.pipeTimer-custom').empty().append('00:00');
  var totalSeconds = Math.round(recorderObject.getStreamTime());
  var timerValue = arrengeTimeString(parseInt(totalSeconds / 60)) + ':' + arrengeTimeString(totalSeconds % 60);
  jQuery('.pipeTimer-custom').empty().append(timerValue);
}

/**
 * Pads a time value with leading zero if needed.
 * @param {number} val
 * @returns {string}
 */
function arrengeTimeString(val) {
  var valString = val + '';
  if (valString.length < 2) {
    return '0' + valString;
  } else {
    return valString;
  }
}