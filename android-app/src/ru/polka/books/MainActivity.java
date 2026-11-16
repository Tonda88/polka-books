package ru.polka.books;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * «Полка» — нативная оболочка вокруг собранного веб-приложения.
 *
 * Приложение целиком лежит в assets/www, поэтому работает без интернета.
 * Сетевые каталоги (Open Library, Internet Archive, LibriVox) открываются
 * напрямую: WebView разрешает запросы со страницы file:// к https-источникам.
 */
public class MainActivity extends Activity {

    private WebView webView;
    private LocalServer server;
    private int serverPort;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.parseColor("#0B0B0F"));
        window.setNavigationBarColor(Color.parseColor("#0B0B0F"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.getDecorView().setSystemUiVisibility(0);
        }

        // Приложение отдаётся локальным сервером: обычный http-origin,
        // поэтому работают IndexedDB, fetch, CORS и медиа.
        try {
            server = new LocalServer(this);
            serverPort = server.start();
        } catch (Exception error) {
            android.util.Log.e("Polka", "Не удалось запустить локальный сервер", error);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B0B0F"));
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Логи веб-приложения видны в logcat.
                android.util.Log.d("PolkaWeb", message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });

        setContentView(webView);
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else if (serverPort > 0) {
            webView.loadUrl("http://127.0.0.1:" + serverPort + "/index.html");
        } else {
            // Резервный путь, если сокет недоступен.
            webView.loadUrl("file:///android_asset/www/index.html");
        }
    }

    /**
     * Внутренние ссылки приложения (локальный сервер) открываем в WebView,
     * внешние сайты — в системном браузере.
     */
    private boolean handleUrl(String url) {
        if (url == null) return false;
        if (url.startsWith("http://127.0.0.1") || url.startsWith("file://")
                || url.startsWith("about:") || url.startsWith("javascript:")) {
            return false;
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                // Если браузера нет — остаёмся в приложении.
                return false;
            }
            return true;
        }
        if (url.startsWith("mailto:") || url.startsWith("tel:")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                // ignore
            }
            return true;
        }
        return false;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // Hash-навигация приложения: WebView ведёт историю переходов.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }
}
