import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, Upload } from 'lucide-react';

const CANVAS_SIZE = 300; // crop preview square size in px

/**
 * AvatarCrop
 * Props:
 *   file        — File object from input[type=file]
 *   onSuccess   — called with avatar_url string after successful upload
 *   onClose     — called when modal is dismissed
 *   apiBase     — base URL for the API (e.g. "http://localhost:5000/api")
 *   token       — JWT access token
 */
export default function AvatarCrop({ file, onSuccess, onClose, apiBase, token }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  // Image position/scale state (offset = top-left corner of image in canvas coords)
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef(null); // { startX, startY, ox, oy }
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  // Load image and set initial scale to fill the canvas
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const initialScale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height);
      const s = Math.max(initialScale, 1);
      setScale(s);
      setOffset({
        x: (CANVAS_SIZE - img.width * s) / 2,
        y: (CANVAS_SIZE - img.height * s) / 2,
      });
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Redraw canvas whenever offset/scale changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return undefined;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(img, offset.x, offset.y, img.width * scale, img.height * scale);
    return undefined;
  }, [offset, scale]);

  // Clamp offset so the image always covers the full canvas
  const clamp = useCallback((ox, oy, s) => {
    const img = imgRef.current;
    if (!img) return { x: ox, y: oy };
    const w = img.width * s;
    const h = img.height * s;
    return {
      x: Math.min(0, Math.max(CANVAS_SIZE - w, ox)),
      y: Math.min(0, Math.max(CANVAS_SIZE - h, oy)),
    };
  }, []);

  const onMouseDown = (e) => {
    drag.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMouseMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    setOffset(clamp(drag.current.ox + dx, drag.current.oy + dy, scale));
  };
  const onMouseUp = () => { drag.current = null; };

  // Touch support
  const onTouchStart = (e) => {
    const t = e.touches[0];
    drag.current = { startX: t.clientX, startY: t.clientY, ox: offset.x, oy: offset.y };
  };
  const onTouchMove = (e) => {
    if (!drag.current) return;
    const t = e.touches[0];
    const dx = t.clientX - drag.current.startX;
    const dy = t.clientY - drag.current.startY;
    setOffset(clamp(drag.current.ox + dx, drag.current.oy + dy, scale));
  };

  const changeScale = (delta) => {
    setScale((prev) => {
      const img = imgRef.current;
      if (!img) return prev;
      const minScale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height);
      const next = Math.max(minScale, Math.min(prev + delta, 4));
      // Re-clamp offset at new scale
      setOffset((o) => clamp(o.x, o.y, next));
      return next;
    });
  };

  // Compress canvas blob to ≤ 200KB
  async function getCompressedBlob() {
    return new Promise((resolve) => {
      const out = document.createElement('canvas');
      out.width = CANVAS_SIZE;
      out.height = CANVAS_SIZE;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvasRef.current, 0, 0);

      // Enforce minimum 200×200 resolution (canvas is already 300×300)
      let quality = 0.92;
      const attempt = () => {
        out.toBlob(
          (blob) => {
            if (!blob) { resolve(null); return; }
            if (blob.size <= 200 * 1024 || quality <= 0.3) { resolve(blob); return; }
            quality -= 0.1;
            attempt();
          },
          'image/jpeg',
          quality
        );
      };
      attempt();
    });
  }

  const handleConfirm = async () => {
    setError('');
    setUploading(true);
    const blob = await getCompressedBlob();
    if (!blob) { setError('Failed to process image'); setUploading(false); return; }

    const form = new FormData();
    form.append('avatar', blob, 'avatar.jpg');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBase}/auth/avatar`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      setUploading(false);
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          onSuccess(data.avatar_url);
        } catch {
          setError('Unexpected server response');
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          setError(data.error || 'Upload failed');
        } catch {
          setError('Upload failed');
        }
      }
    };

    xhr.onerror = () => { setUploading(false); setError('Network error'); };
    xhr.send(form);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="font-semibold text-white">Crop Photo</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" disabled={uploading}>
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-500 text-center">Drag to reposition · Zoom in/out as needed</p>

          {/* Canvas crop area */}
          <div className="flex justify-center">
            <div className="relative rounded-full overflow-hidden border-2 border-primary-500" style={{ width: CANVAS_SIZE, height: CANVAS_SIZE, cursor: 'grab' }}>
              <canvas
                ref={canvasRef}
                width={CANVAS_SIZE}
                height={CANVAS_SIZE}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onMouseUp}
                style={{ display: 'block', cursor: 'grab' }}
              />
            </div>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => changeScale(-0.1)}
              className="p-2 bg-gray-800 rounded-lg text-gray-400 hover:text-white"
              aria-label="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <span className="text-xs text-gray-500 w-16 text-center">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => changeScale(0.1)}
              className="p-2 bg-gray-800 rounded-lg text-gray-400 hover:text-white"
              aria-label="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
          </div>

          {/* Progress bar */}
          {uploading && (
            <div className="space-y-1">
              <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary-500 h-2 rounded-full transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 text-center">{progress}%</p>
            </div>
          )}

          {error && <p className="text-xs text-red-400 text-center">{error}</p>}

          <button
            type="button"
            onClick={handleConfirm}
            disabled={uploading || !imgRef.current}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
          >
            <Upload size={14} />
            {uploading ? 'Uploading…' : 'Upload Photo'}
          </button>
        </div>
      </div>
    </div>
  );
}
