package com.pragyesh.executionos;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // local plugins must be registered before the bridge starts
        registerPlugin(StudySpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
