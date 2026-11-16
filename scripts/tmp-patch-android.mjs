import { readFileSync, writeFileSync } from 'node:fs';

let t = readFileSync('android-app/src/ru/polka/books/LocalServer.java', 'utf8');

// 1) health: googleBooks = false (ключа в APK нет; используется ключ пользователя)
t = t.replace(
  'byte[] body = "{\\"ok\\":true,\\"proxy\\":true,\\"native\\":true}".getBytes(StandardCharsets.UTF_8);',
  'byte[] body = "{\\"ok\\":true,\\"proxy\\":true,\\"native\\":true,\\"googleBooks\\":false}".getBytes(StandardCharsets.UTF_8);',
);

// 2) маршрут /api/googlebooks
t = t.replace(
  `        if (path.startsWith("/api/fetch")) {
            proxy(path, rangeHeader, out);
            return;
        }`,
  `        if (path.startsWith("/api/fetch")) {
            proxy(path, rangeHeader, out);
            return;
        }
        if (path.startsWith("/api/googlebooks")) {
            proxyGoogleBooks(path, out);
            return;
        }`,
);

// 3) метод прокси Google Books (ключ приходит из настроек приложения)
const method = `
    /**
     * Прокси Google Books: в APK ключ вводит пользователь в настройках,
     * он передаётся параметром key и не хранится в коде приложения.
     * Прокси нужен, чтобы не зависеть от CORS WebView.
     */
    private void proxyGoogleBooks(String rawPath, OutputStream out) throws IOException {
        Map<String, String> params = parseQuery(rawPath);
        String path = params.remove("path");
        String key = params.remove("key");
        if (path == null || !path.matches("[A-Za-z0-9/_-]+")) {
            sendJsonError(out, 400, "Некорректный путь запроса Google Books");
            return;
        }
        if (key == null || key.isEmpty()) {
            sendJsonError(out, 503, "Google Books: ключ не задан в настройках приложения");
            return;
        }

        StringBuilder query = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (query.length() > 0) query.append('&');
            query.append(URLEncoder.encode(entry.getKey(), "UTF-8"))
                    .append('=')
                    .append(URLEncoder.encode(entry.getValue(), "UTF-8"));
        }
        query.append("&key=").append(URLEncoder.encode(key, "UTF-8"));

        String target = "https://www.googleapis.com/books/v1/" + path + "?" + query;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(25_000);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = stream != null ? readAll(stream) : new byte[0];
            writeHeaders(out, status, "application/json; charset=utf-8", body.length);
            out.write(body);
            out.flush();
        } catch (IOException error) {
            sendJsonError(out, 502, "Google Books недоступен: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Разбирает query-строку запроса в карту (без декодирования path). */
    private static Map<String, String> parseQuery(String rawPath) throws IOException {
        Map<String, String> result = new HashMap<>();
        int index = rawPath.indexOf('?');
        if (index < 0) return result;
        String query = rawPath.substring(index + 1);
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String name = eq >= 0 ? pair.substring(0, eq) : pair;
            String value = eq >= 0 ? pair.substring(eq + 1) : "";
            result.put(URLDecoder.decode(name, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
        }
        return result;
    }
`;
// вставляем перед разделом "// ------------------------------------------------------------------- прокси"
t = t.replace(
  '    // ------------------------------------------------------------------- прокси',
  method + '\n    // ------------------------------------------------------------------- прокси',
);

// 4) импорт URLEncoder
t = t.replace('import java.net.URLDecoder;', 'import java.net.URLDecoder;\nimport java.net.URLEncoder;');

writeFileSync('android-app/src/ru/polka/books/LocalServer.java', t);
console.log({
  health: t.includes('\\"googleBooks\\":false'),
  route: t.includes('/api/googlebooks'),
  method: t.includes('proxyGoogleBooks(String rawPath'),
  imports: t.includes('import java.net.URLEncoder;'),
});
