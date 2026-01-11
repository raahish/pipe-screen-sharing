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