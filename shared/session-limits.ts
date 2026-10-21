// Count UTF-16 code units consistently in the browser and server validation.
export const MAX_SESSION_CHARACTERS = 1024 * 1024;
export const SESSION_LENGTH_ERROR = 'session 内容超过 1,048,576 个字符，请确认只复制了 session JSON。';
// Allow JSON escaping and multibyte text without enlarging unrelated API limits.
export const SESSION_REQUEST_BYTES = 8 * 1024 * 1024;
