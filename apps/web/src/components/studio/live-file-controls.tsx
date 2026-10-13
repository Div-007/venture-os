"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import { prepareLiveFileDownload, uploadLiveFile } from "@/lib/studio-api";
import { isCompressibleImage, prepareUpload } from "@/lib/image-compress";
import { Field, inputClass, secondaryClass } from "@/components/studio/primitives";

type UploadedFile = Awaited<ReturnType<typeof uploadLiveFile>>;

export function LiveFileUpload({ ventureId, groupId, taskId, onUploaded }: {
  ventureId: string;
  groupId?: string;
  taskId?: string;
  onUploaded: (file: UploadedFile) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [hd, setHd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const form = event.currentTarget;
    setBusy(true); setError("");
    try {
      // Photos shrink to 1080p WebP unless HD is ticked, as in chat; HD goes back off after each upload.
      const prepared = await prepareUpload(file, { hd });
      if (prepared.file.size > 25 * 1024 * 1024) throw new Error(hd ? "This photo is over 25 MB, too large to upload in HD." : "Choose a file up to 25 MB.");
      const uploaded = await uploadLiveFile(prepared.file, { ventureId, ...(groupId ? { groupId } : {}), ...(taskId ? { taskId } : {}) }, undefined, { ...(prepared.width && prepared.height ? { width: prepared.width, height: prepared.height } : {}), ...(prepared.hd ? { hd: true as const } : {}) });
      setFile(null); setHd(false); form.reset(); onUploaded(uploaded);
    } catch (cause) { setError(describeError(cause, "The upload failed.")); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="space-y-3"><Field label="Choose a file"><input type="file" required accept=".pdf,.md,.txt,.png,.jpg,.jpeg,.webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className={`${inputClass} py-2`} /></Field>{file && isCompressibleImage(file.type) && <label className="vso-fade-enter flex items-start gap-2 text-xs text-neutral-600"><input type="checkbox" checked={hd} onChange={(event) => setHd(event.target.checked)} className="mt-0.5" /><span><span className="font-semibold text-neutral-800">Upload in HD</span> · the original, untouched. Otherwise the photo is made smaller (1080p) so it uploads and opens fast.</span></label>}<p className="text-xs leading-5 text-neutral-500">PDF, Markdown, text, PNG, JPEG, or WebP · 25 MB maximum. A signed upload is finalized only after the file reaches storage.</p>{error && <p role="alert" className="text-xs font-semibold text-danger-text">{error}</p>}<button disabled={busy || !file || !ventureId || (!!taskId && !groupId)} className={secondaryClass}>{busy ? "Uploading…" : "Upload file"}</button></form>;
}

export function LiveFileDownload({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [objectUrl, setObjectUrl] = useState("");

  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  async function prepare() {
    setBusy(true); setError("");
    try { setObjectUrl(await prepareLiveFileDownload(id)); }
    catch (cause) { setError(describeError(cause, "Could not download this file.")); }
    finally { setBusy(false); }
  }

  return <span className="inline-flex flex-col items-start gap-1">{objectUrl ? <a href={objectUrl} download={name} className="inline-flex min-h-9 items-center rounded-lg px-2 text-xs font-semibold text-primary-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Save {name}</a> : <button type="button" onClick={prepare} disabled={busy} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{busy ? "Preparing download…" : `Prepare download: ${name}`}</button>}{error && <span role="alert" className="text-xs text-danger-text">{error}</span>}</span>;
}
