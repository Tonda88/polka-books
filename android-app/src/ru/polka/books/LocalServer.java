package ru.polka.books;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Мини-сервер внутри приложения.
 *
 * Зачем: WebView на file:// ограничивает IndexedDB и сетевые запросы.
 * Отдавая приложение с http://127.0.0.1:<port>, получаем обычный браузерный
 * origin — работают IndexedDB, fetch, CORS и медиа.
 *
 * Кроме статики из assets/www сервер умеет:
 *  - /api/health        — признак, что прокси доступен;
 *  - /api/fetch?url=…   — прокси открытых файлов (EPUB/PDF) с белым списком
 *                         доменов, как в server/serve.mjs на ПК.
 */
public class LocalServer {

    private static final String TAG = "PolkaServer";
    private static final String[] ALLOWED_HOSTS = {
            "archive.org", "openlibrary.org", "covers.openlibrary.org",
            "gutenberg.org", "www.gutenberg.org", "librivox.org", "www.librivox.org"
    };
    private static final long MAX_BYTES = 600L * 1024 * 1024;

    private final AssetManager assets;
    private ServerSocket serverSocket;
    private Thread thread;
    private volatile boolean running;

    public LocalServer(Context context) {
        this.assets = context.getAssets();
    }

    /** Запускает сервер на свободном порту и возвращает его. */
    public int start() throws IOException {
        serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        running = true;
        final int port = serverSocket.getLocalPort();
        thread = new Thread(new Runnable() {
            @Override
            public void run() {
                loop();
            }
        }, "polka-http");
        thread.setDaemon(true);
        thread.start();
        Log.i(TAG, "serving on http://127.0.0.1:" + port);
        return port;
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
    }

    private void loop() {
        while (running) {
            Socket client = null;
            try {
                client = serverSocket.accept();
                handle(client);
            } catch (IOException error) {
                if (running) Log.w(TAG, "accept: " + error.getMessage());
            } catch (Throwable error) {
                Log.w(TAG, "handle: " + error.getMessage());
            } finally {
                if (client != null) {
                    try {
                        client.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        }
    }

    private void handle(Socket client) throws IOException {
        client.setSoTimeout(30_000);
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1));
        String requestLine = reader.readLine();
        if (requestLine == null) return;

        String rangeHeader = null;
        String header;
        while ((header = reader.readLine()) != null && !header.isEmpty()) {
            int colon = header.indexOf(':');
            if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("Range")) {
                rangeHeader = header.substring(colon + 1).trim();
            }
        }

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return;
        String path = parts[1];

        OutputStream out = client.getOutputStream();
        if (parts[0].equalsIgnoreCase("OPTIONS")) {
            writeHeaders(out, 204, null, 0);
            return;
        }
        if (path.startsWith("/api/health")) {
            byte[] body = "{\"ok\":true,\"proxy\":true,\"native\":true}".getBytes(StandardCharsets.UTF_8);
            writeHeaders(out, 200, "application/json; charset=utf-8", body.length);
            out.write(body);
            return;
        }
        if (path.startsWith("/api/fetch")) {
            proxy(path, rangeHeader, out);
            return;
        }
        serveAsset(path, out);
    }

    // ------------------------------------------------------------------ статика

    private void serveAsset(String rawPath, OutputStream out) throws IOException {
        String path = rawPath;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        if (path.equals("/") || path.isEmpty()) path = "/index.html";

        String assetPath = "www" + path;
        InputStream stream = null;
        try {
            stream = assets.open(assetPath);
        } catch (IOException missing) {
            // SPA-фолбэк: неизвестный путь отдаём как index.html.
            assetPath = "www/index.html";
            stream = assets.open(assetPath);
        }

        byte[] data = readAll(stream);
        String type = mimeFor(assetPath);
        writeHeaders(out, 200, type, data.length);
        out.write(data);
        out.flush();
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------- прокси

    private void proxy(String rawPath, String rangeHeader, OutputStream out) throws IOException {
        int index = rawPath.indexOf("url=");
        if (index < 0) {
            sendJsonError(out, 400, "Параметр url обязателен");
            return;
        }
        String encoded = rawPath.substring(index + 4);
        int amp = encoded.indexOf('&');
        if (amp >= 0) encoded = encoded.substring(0, amp);

        String target;
        try {
            target = URLDecoder.decode(encoded, "UTF-8");
        } catch (Exception error) {
            sendJsonError(out, 400, "Некорректный URL");
            return;
        }

        URL url;
        try {
            url = new URL(target);
        } catch (Exception error) {
            sendJsonError(out, 400, "Некорректный URL");
            return;
        }
        String protocol = url.getProtocol();
        if (!protocol.equals("https") && !protocol.equals("http")) {
            sendJsonError(out, 400, "Разрешены только http(s)-адреса");
            return;
        }
        if (!isAllowedHost(url.getHost())) {
            sendJsonError(out, 403, "Домен " + url.getHost() + " не входит в белый список");
            return;
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(180_000);
            connection.setRequestProperty("User-Agent", "PolkaBooks/1.0 (public-domain book downloader)");
            connection.setRequestProperty("Accept", "*/*");
            if (rangeHeader != null) connection.setRequestProperty("Range", rangeHeader);

            int status = connection.getResponseCode();
            if (status != 200 && status != 206) {
                sendJsonError(out, status == 404 ? 404 : 502, "Источник вернул " + status);
                return;
            }
            long length = connection.getContentLengthLong();
            if (length > MAX_BYTES) {
                sendJsonError(out, 413, "Файл больше допустимого размера");
                return;
            }

            String type = connection.getContentType();
            Map<String, String> extra = new HashMap<>();
            String contentRange = connection.getHeaderField("Content-Range");
            if (contentRange != null) extra.put("Content-Range", contentRange);

            int responseStatus = status == 206 ? 206 : 200;
            writeRawHeaders(out, responseStatus, type != null ? type : "application/octet-stream",
                    length, extra);

            InputStream stream = new BufferedInputStream(connection.getInputStream(), 64 * 1024);
            byte[] buffer = new byte[64 * 1024];
            long written = 0;
            int read;
            while ((read = stream.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                written += read;
                if (written > MAX_BYTES) break;
            }
            out.flush();
            stream.close();
        } catch (IOException error) {
            sendJsonError(out, 502, "Не удалось получить файл: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean isAllowedHost(String hostname) {
        String host = hostname.toLowerCase(Locale.ROOT);
        for (String allowed : ALLOWED_HOSTS) {
            if (host.equals(allowed)) return true;
        }
        return host.endsWith(".archive.org");
    }

    // ------------------------------------------------------------------ утилиты

    private static void sendJsonError(OutputStream out, int status, String message) throws IOException {
        String safe = message.replace("\"", "'");
        byte[] body = ("{\"error\":\"" + safe + "\"}").getBytes(StandardCharsets.UTF_8);
        writeHeaders(out, status, "application/json; charset=utf-8", body.length);
        out.write(body);
        out.flush();
    }

    private static void writeHeaders(OutputStream out, int status, String contentType, long length)
            throws IOException {
        writeRawHeaders(out, status, contentType, length, null);
    }

    private static void writeRawHeaders(OutputStream out, int status, String contentType, long length,
                                        Map<String, String> extra) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(status == 206 ? " Partial Content" : " OK").append("\r\n");
        if (contentType != null) head.append("Content-Type: ").append(contentType).append("\r\n");
        if (length >= 0) head.append("Content-Length: ").append(length).append("\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Cache-Control: no-cache\r\n");
        head.append("Connection: close\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> entry : extra.entrySet()) {
                head.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
            }
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static byte[] readAll(InputStream stream) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int read;
        while ((read = stream.read(chunk)) > 0) buffer.write(chunk, 0, read);
        stream.close();
        return buffer.toByteArray();
    }
}
