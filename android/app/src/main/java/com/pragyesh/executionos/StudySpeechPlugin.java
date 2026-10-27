package com.pragyesh.executionos;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Speech-to-text for the Study tab's "Explain it in your own words" step. Android's WebView has no
 * speech API, so this uses the phone's own SpeechRecognizer. listen() resolves with the final text;
 * "partial" events carry the words heard so far. Typing always remains possible.
 */
@CapacitorPlugin(name = "StudySpeech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public class StudySpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micGranted");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void micGranted(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) start(call);
        else call.reject("Microphone permission was not given. You can still type your explanation.", "denied");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    private void start(PluginCall call) {
        final String language = call.getString("language", "en-IN");
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Speech recognition is not available on this phone. Type your explanation instead.", "unavailable");
                return;
            }
            if (recognizer != null) recognizer.destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L);
            recognizer.setRecognitionListener(new RecognitionListener() {
                private boolean done = false;

                private String best(Bundle b) {
                    ArrayList<String> list = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    return list == null || list.isEmpty() ? "" : list.get(0);
                }

                @Override
                public void onPartialResults(Bundle b) {
                    JSObject r = new JSObject();
                    r.put("text", best(b));
                    notifyListeners("partial", r);
                }

                @Override
                public void onResults(Bundle b) {
                    if (done) return;
                    done = true;
                    JSObject r = new JSObject();
                    r.put("text", best(b));
                    call.resolve(r);
                }

                @Override
                public void onError(int error) {
                    if (done) return;
                    done = true;
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        JSObject r = new JSObject();
                        r.put("text", "");
                        call.resolve(r);
                    } else call.reject("Speech recognition stopped (code " + error + "). Try again or type.", String.valueOf(error));
                }

                @Override public void onReadyForSpeech(Bundle b) { notifyListeners("ready", new JSObject()); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float v) {}
                @Override public void onBufferReceived(byte[] bytes) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int i, Bundle b) {}
            });
            recognizer.startListening(intent);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.destroy();
        super.handleOnDestroy();
    }
}
