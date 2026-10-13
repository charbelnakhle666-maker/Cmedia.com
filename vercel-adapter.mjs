export async function runNetlifyHandler(handler, request, response) {
  const host = request.headers.host || "localhost";
  const url = new URL(request.url || "/", `https://${host}`);
  const contentType = request.headers["content-type"] || "";
  let body = request.body;

  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  } else if (body !== undefined && typeof body !== "string") {
    body = contentType.includes("application/x-www-form-urlencoded")
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
  }

  const result = await handler({
    httpMethod: request.method || "GET",
    headers: request.headers,
    rawUrl: url.toString(),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body || "",
    isBase64Encoded: false
  });

  response.statusCode = result.statusCode || 200;
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  response.end(
    response.statusCode === 204 || response.statusCode === 304
      ? undefined
      : result.body || ""
  );
}
