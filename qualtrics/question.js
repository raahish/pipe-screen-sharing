var questionName = "VQ11"; 
var videoURL = "VQ11_pipe_url"; 
var mimetype = 'audio/webm'; 
var Q_CHL = "${e://Field/Q_CHL}"; 

var pipeParams = { 
    size: { width: "100%", height: 510, }, 
    qualityurl: "avq/480p.xml", 
    accountHash: "fb6878ab6bdc0a6bc55c2a6b3f695e05",
    eid: "KCfFkj", 
    mrt: 120, 
    avrec: 1, 
    sis: 0, // Changed to 0 so user sees the "Record Screen" button
    srec: 1, // ENABLE SCREEN RECORDING
    mimetype: mimetype, 
    questionName: questionName, 
    payload: "${e://Field/ResponseID}", 
}; 

var validationDetails = { min_streamtime: 30, required: true }; 
if (Q_CHL == "preview"){ 
    var validationDetails = { min_streamtime:0, required: false } 
}; 

function updateEmbeddedData(data){ 
    Qualtrics.SurveyEngine.setEmbeddedData(videoURL, data); 
} 

/**
 * Detects mobile operating system and BLOCKS usage if true.
 * Returns true if mobile/tablet, false if desktop.
 */
function checkDeviceAndBlock() {
    var userAgent = navigator.userAgent || navigator.vendor || window.opera;
    var isMobile = false;

    // Basic mobile checks
    if (/windows phone/i.test(userAgent) || /android/i.test(userAgent) || /iPad|iPhone|iPod/.test(userAgent)) {
        isMobile = true;
    }
    
    // If it is mobile, manipulate the DOM immediately to block entry
    if (isMobile) {
        console.log("Mobile device detected. Blocking screen recording.");
        // Hide the grant button
        jQuery("#grant-btn").hide();
        
        // Update the permission modal text to show error
        jQuery("#perm-title").text("Desktop Computer Required");
        jQuery("#perm-desc").html("Screen recording is not supported on mobile devices.<br><br><b>Please open this link on a desktop computer (Mac or Windows) to continue.</b>");
        
        // Hide the default Qualtrics Next button just in case
        jQuery("#NextButton").hide();
        jQuery("#NextButton-custom").hide();
    }
    
    return isMobile;
}

Qualtrics.SurveyEngine.addOnload(function(){ 
    jQuery("#SkinContent #Buttons").hide(); 
    jQuery("#NextButton-custom").hide(); 
    
    // Check device immediately on load
    checkDeviceAndBlock(); 

    jQuery("#permission").modal({ 
        escapeClose:false, 
        clickClose: false, 
        showClose: false 
    }); 
});