// GitHub REST 호출 공통 (토큰은 절대 로그에 남기지 않는다)
export async function gh(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'BusanCultureAlert',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const hint = res.status === 401 ? ' (토큰이 틀렸거나 만료됨)' : res.status === 403 || res.status === 404 ? ' (토큰 권한 부족 또는 대상 없음)' : '';
    const err = new Error(`GitHub ${res.status}${hint}: ${json?.message || text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return json ?? text;
}
