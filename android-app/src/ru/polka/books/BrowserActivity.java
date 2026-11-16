package ru.polka.books;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.Locale;

/**
 * Встроенный браузер: открывает реальную поисковую выдачу и сайты.
 *
 * Никакого парсинга страниц — пользователь сам ходит по ссылкам.
 * Скачанные файлы книг (EPUB/FB2/PDF/TXT/MOBI) перехватываются и
 * сохраняются в память приложения, после чего возвращаются в основной
 * экран как готовый импорт.
 */
public class BrowserActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_FILE = "saved_file";
    public static final String EXTRA_FILE_NAME = "saved_name";
    public static final String EXTRA_FILE_MIME = "saved_mime";

    private WebView webView;
    private TextView title;
    private ProgressBar progress;
    private boolean downloading = false;

    private static boolean isBookFile(String url, String mime) {
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.matches(".*\\.(epub|fb2|pdf|txt|mobi)(\\?.*)?$")) return true;
        String type = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        return type.contains("epub")
                || type.contains("fb2")
                || type.contains("fictionbook")
                || type.equals("application/pdf")
                || type.startsWith("text/plain")
                || type.contains("mobipocket");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#0B0B0F"));
        window.setNavigationBarColor(Color.parseColor("#0B0B0F"));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B0B0F"));

        // Верхняя панель: назад, домен, обновить, закрыть.
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(8, 8, 8, 8);

        Button back = new Button(this);
        back.setText("‹");
        back.setTextSize(22);
        back.setTextColor(Color.WHITE);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });
        bar.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));

        title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button openExternal = new Button(this);
        openExternal.setText("↗");
        openExternal.setTextSize(18);
        openExternal.setTextColor(Color.WHITE);
        openExternal.setBackgroundColor(Color.TRANSPARENT);
        openExternal.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (webView.getUrl() != null) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(webView.getUrl())));
                }
            }
        });
        bar.addView(openExternal, new LinearLayout.LayoutParams(dp(44), dp(44)));

        Button close = new Button(this);
        close.setText("✕");
        close.setTextSize(16);
        close.setTextColor(Color.WHITE);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));

        root.addView(bar);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B0B0F"));
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Обычный мобильный Chrome UA: поисковики показывают нормальную версию.
        String ua = settings.getUserAgentString();
        settings.setUserAgentString(ua.replace("; wv", ""));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if (scheme != null && (scheme.equals("http") || scheme.equals("https"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (title != null) title.setText(webView.getTitle() != null ? webView.getTitle() : url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        // Перехват загрузок: файлы книг сохраняем в память приложения.
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                String name = fileNameFrom(url, contentDisposition, mimeType);
                if (!isBookFile(url, mimeType) && !isBookFile(name, null)) {
                    // Не книжный файл — отдаём системному браузеру.
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                    return;
                }
                downloadFile(url, userAgent, name, mimeType, contentLength);
            }
        });

        String url = getIntent().getStringExtra(EXTRA_URL);
        webView.loadUrl(url != null ? url : "https://www.google.com");
    }

    private String fileNameFrom(String url, String contentDisposition, String mime) {
        if (contentDisposition != null) {
            int index = contentDisposition.toLowerCase(Locale.ROOT).indexOf("filename=");
            if (index >= 0) {
                String raw = contentDisposition.substring(index + 9).replace("\"", "").trim();
                if (!raw.isEmpty()) return raw;
            }
        }
        try {
            String path = Uri.parse(url).getLastPathSegment();
            if (path != null && !path.isEmpty()) return URLDecoder.decode(path, "UTF-8");
        } catch (Exception ignored) {
        }
        return "book-" + System.currentTimeMillis() + extensionFor(mime);
    }

    private String extensionFor(String mime) {
        if (mime == null) return ".bin";
        if (mime.contains("epub")) return ".epub";
        if (mime.contains("fb2") || mime.contains("fictionbook")) return ".fb2";
        if (mime.equals("application/pdf")) return ".pdf";
        if (mime.startsWith("text/plain")) return ".txt";
        if (mime.contains("mobipocket")) return ".mobi";
        return ".bin";
    }

    private void downloadFile(String url, String userAgent, String name, String mime, long contentLength) {
        if (downloading) return;
        downloading = true;
        Toast.makeText(this, "Скачиваем книгу…", Toast.LENGTH_SHORT).show();
        final Activity activity = this;
        final String safeMime = mime;
        final String safeName = name;

        new Thread(new Runnable() {
            @Override
            public void run() {
            File target = null;
            try {
                File dir = new File(getFilesDir(), "imports");
                if (!dir.exists()) dir.mkdirs();
                target = new File(dir, safeName.replaceAll("[\\\\/:*?\"<>|]", "_"));
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(30_000);
                connection.setReadTimeout(180_000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", userAgent != null ? userAgent : "Mozilla/5.0");
                int status = connection.getResponseCode();
                if (status != 200) {
                    throw new java.io.IOException("HTTP " + status);
                }
                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    long total = 0;
                    while ((read = input.read(buffer)) > 0) {
                        output.write(buffer, 0, read);
                        total += read;
                        final int percent = contentLength > 0 ? (int) (total * 100 / contentLength) : -1;
                        if (percent >= 0) {
                            new Handler(Looper.getMainLooper()).post(new Runnable() {
                                @Override
                                public void run() {
                                    progress.setProgress(percent);
                                }
                            });
                        }
                    }
                }
                final File saved = target;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        Intent result = new Intent();
                        result.putExtra(EXTRA_FILE, saved.getAbsolutePath());
                        result.putExtra(EXTRA_FILE_NAME, safeName);
                        result.putExtra(EXTRA_FILE_MIME, safeMime);
                        setResult(RESULT_OK, result);
                        finish();
                    }
                });
            } catch (Exception error) {
                if (target != null) target.delete();
                final String message = error.getMessage() == null ? "неизвестная ошибка" : error.getMessage();
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        downloading = false;
                        Toast.makeText(activity, "Не удалось скачать файл: " + message, Toast.LENGTH_LONG).show();
                    }
                });
            }
            }
        }).start();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }
}
