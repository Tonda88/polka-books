package ru.polka.books;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * «Полка» — нативная оболочка вокруг собранного веб-приложения.
 *
 * Дополнительно к локальному серверу приложение даёт веб-части:
 *  - встроенный браузер (BrowserActivity) для интернет-поиска книг;
 *  - системный выбор файла (SAF) и приём файлов через «Поделиться»;
 *  - очередь импортов: скачанные книги передаются в JS в base64.
 */
public class MainActivity extends Activity {

    private static final int REQ_BROWSER = 4101;
    private static final int REQ_PICK = 4102;

    private WebView webView;
    private LocalServer server;
    private int serverPort;
    private ValueCallback<Uri[]> fileCallback;

    private final List<ImportFile> pendingImports = new ArrayList<>();

    /** Файл, подготовленный нативной частью для импорта в веб-приложение. */
    private static class ImportFile {
        final String id;
        final String name;
        final String mime;
        final File file;
        final String origin;

        ImportFile(String id, String name, String mime, File file, String origin) {
            this.id = id;
            this.name = name;
            this.mime = mime;
            this.file = file;
            this.origin = origin;
        }
    }

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
                android.util.Log.d("PolkaWeb", message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, BOOK_MIME_TYPES);
                try {
                    startActivityForResult(intent, REQ_PICK);
                } catch (Exception error) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.addJavascriptInterface(new NativeBridge(), "PolkaNative");

        setContentView(webView);
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else if (serverPort > 0) {
            webView.loadUrl("http://127.0.0.1:" + serverPort + "/index.html");
        } else {
            webView.loadUrl("file:///android_asset/www/index.html");
        }
    }

    private static final String[] BOOK_MIME_TYPES = {
            "application/epub+zip",
            "application/x-fictionbook+xml",
            "application/pdf",
            "text/plain",
            "application/x-mobipocket-ebook",
            "application/octet-stream",
            "*/*",
    };

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
                return false;
            }
            return true;
        }
        if (url.startsWith("mailto:") || url.startsWith("tel:")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ мост

    /** Методы, доступные веб-приложению как window.PolkaNative. */
    private class NativeBridge {
        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        @JavascriptInterface
        public void openBrowser(String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(MainActivity.this, BrowserActivity.class);
                        intent.putExtra(BrowserActivity.EXTRA_URL, url);
                        startActivityForResult(intent, REQ_BROWSER);
                    } catch (Exception error) {
                        android.util.Log.e("Polka", "Не удалось открыть браузер", error);
                    }
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void pickFile() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, BOOK_MIME_TYPES);
                    try {
                        startActivityForResult(intent, REQ_PICK);
                    } catch (Exception error) {
                        android.util.Log.e("Polka", "Не удалось открыть выбор файла", error);
                    }
                }
            });
        }

        @JavascriptInterface
        public String getPendingImports() {
            JSONArray array = new JSONArray();
            synchronized (pendingImports) {
                for (ImportFile item : pendingImports) {
                    try {
                        JSONObject object = new JSONObject();
                        object.put("id", item.id);
                        object.put("name", item.name);
                        object.put("mime", item.mime);
                        object.put("size", item.file.length());
                        object.put("origin", item.origin);
                        array.put(object);
                    } catch (Exception ignored) {
                    }
                }
            }
            return array.toString();
        }

        @JavascriptInterface
        public String readImport(String id) {
            synchronized (pendingImports) {
                for (ImportFile item : pendingImports) {
                    if (!item.id.equals(id)) continue;
                    try (FileInputStream input = new FileInputStream(item.file)) {
                        ByteArrayOutputStream output = new ByteArrayOutputStream();
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
                        return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
                    } catch (Exception error) {
                        return "";
                    }
                }
            }
            return "";
        }

        @JavascriptInterface
        public void clearPendingImports() {
            synchronized (pendingImports) {
                for (ImportFile item : pendingImports) {
                    // Удаляем только временные файлы импорта; исходник не трогаем.
                    if (item.file.getAbsolutePath().contains("/imports/")) item.file.delete();
                }
                pendingImports.clear();
            }
        }

        @JavascriptInterface
        public void shareText(String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent = new Intent(Intent.ACTION_SEND);
                    intent.setType("text/plain");
                    intent.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(intent, "Поделиться"));
                }
            });
        }
    }

    // ------------------------------------------------------------ импорт

    private void addPending(File file, String name, String mime, String origin) {
        if (file == null || !file.exists() || file.length() == 0) return;
        synchronized (pendingImports) {
            pendingImports.add(new ImportFile(
                    "imp:" + System.currentTimeMillis() + ":" + pendingImports.size(),
                    name,
                    mime,
                    file,
                    origin));
        }
        notifyPending();
    }

    private void notifyPending() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                webView.evaluateJavascript(
                        "window.PolkaOnImport && window.PolkaOnImport();", null);
            }
        });
    }

    /** Копирует выбранный/присланный документ в папку импорта приложения. */
    private void copyToImports(Uri uri, String origin) {
        if (uri == null) return;
        try {
            String name = queryDisplayName(uri);
            String mime = getContentResolver().getType(uri);
            File dir = new File(getFilesDir(), "imports");
            if (!dir.exists()) dir.mkdirs();
            File target = new File(dir, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
            try (InputStream input = getContentResolver().openInputStream(uri);
                 FileOutputStream output = new FileOutputStream(target)) {
                if (input == null) return;
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            }
            addPending(target, name, mime, origin);
        } catch (Exception error) {
            android.util.Log.e("Polka", "Не удалось скопировать файл", error);
        }
    }

    private String queryDisplayName(Uri uri) {
        String name = null;
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) name = cursor.getString(index);
            }
        } catch (Exception ignored) {
        }
        if (name == null) {
            String last = uri.getLastPathSegment();
            name = last != null ? last : "import-" + System.currentTimeMillis();
        }
        return name;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_PICK) {
            Uri uri = data != null ? data.getData() : null;
            if (resultCode == RESULT_OK && uri != null) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(new Uri[]{uri});
                    fileCallback = null;
                    return;
                }
                copyToImports(uri, "picker");
            } else if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
            return;
        }

        if (requestCode == REQ_BROWSER) {
            if (resultCode == RESULT_OK && data != null) {
                String path = data.getStringExtra(BrowserActivity.EXTRA_FILE);
                String name = data.getStringExtra(BrowserActivity.EXTRA_FILE_NAME);
                String mime = data.getStringExtra(BrowserActivity.EXTRA_FILE_MIME);
                if (path != null) {
                    addPending(new File(path), name != null ? name : "book", mime, "download");
                }
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncomingIntent(intent);
    }

    /** «Поделиться файлом» и открытие файла из другого приложения. */
    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        }
        if (uri != null) copyToImports(uri, "share");
    }

    @Override
    protected void onResume() {
        super.onResume();
        synchronized (pendingImports) {
            if (!pendingImports.isEmpty()) notifyPending();
        }
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
