// A stable identifier for one rendered score page.
//
// Recognition, feedback, and the training corpus all need to agree on "this
// page", across reloads and across devices. The rendered image bytes are the
// only thing that is the same every time — the song ID is regenerated on every
// upload, and the title is exactly what recognition might have got wrong.
//
// The hash is of the image, so it is not reversible to lyrics and is safe to
// store and send alongside accuracy numbers.

/** SHA-256 of a rendered page, as lowercase hex. */
export async function hashPageImage(dataUrl: string): Promise<string> {
  const payload = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of any canonical string (a serialized score, a manifest line). */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
