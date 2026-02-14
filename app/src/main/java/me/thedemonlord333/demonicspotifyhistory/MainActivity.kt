package me.thedemonlord333.demonicspotifyhistory

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var pendingAuthCode: String? = null
    private var pendingAuthState: String? = null
    private var pendingAuthError: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        setupWebView()
        webView.loadUrl("file:///android_asset/index.html")

        // Handle intent if app was launched via deep link
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val data: Uri? = intent.data
        if (data != null && data.scheme == "demonicspotifyhistory" && data.host == "callback") {
            val code = data.getQueryParameter("code")
            val state = data.getQueryParameter("state")
            val error = data.getQueryParameter("error")

            if (error != null) {
                pendingAuthError = error
                pendingAuthCode = null
                pendingAuthState = null
                deliverAuthResult()
            } else if (code != null) {
                pendingAuthCode = code
                pendingAuthState = state ?: ""
                pendingAuthError = null
                deliverAuthResult()
            }
        }
    }

    private fun deliverAuthResult() {
        // Deliver the auth result to the WebView via JavaScript
        if (pendingAuthError != null) {
            val escapedError = pendingAuthError!!.replace("'", "\\'").replace("\\", "\\\\")
            webView.evaluateJavascript("if(typeof onSpotifyAuthError==='function'){onSpotifyAuthError('$escapedError')}", null)
            pendingAuthError = null
        } else if (pendingAuthCode != null) {
            val escapedCode = pendingAuthCode!!.replace("'", "\\'").replace("\\", "\\\\")
            val escapedState = (pendingAuthState ?: "").replace("'", "\\'").replace("\\", "\\\\")
            webView.evaluateJavascript("if(typeof onSpotifyAuthSuccess==='function'){onSpotifyAuthSuccess('$escapedCode','$escapedState')}", null)
            pendingAuthCode = null
            pendingAuthState = null
        }
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            databaseEnabled = true
            setSupportMultipleWindows(false)
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        webView.addJavascriptInterface(AndroidBridge(), "Android")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // Allow loading local assets
                if (url.startsWith("file:///android_asset/")) {
                    return false
                }
                // Open external URLs in browser
                val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                startActivity(browserIntent)
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // Deliver any pending auth result after page load
                deliverAuthResult()
            }
        }

        webView.webChromeClient = WebChromeClient()
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun openUrl(url: String) {
            runOnUiThread {
                try {
                    val customTabsIntent = CustomTabsIntent.Builder()
                        .setShowTitle(true)
                        .build()
                    customTabsIntent.launchUrl(this@MainActivity, Uri.parse(url))
                } catch (e: Exception) {
                    // Fallback to regular browser if Custom Tabs not available
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    startActivity(browserIntent)
                }
            }
        }
    }

    @Deprecated("Use OnBackPressedCallback instead")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }
}
