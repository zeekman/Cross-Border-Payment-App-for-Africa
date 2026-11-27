import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { FileText, X } from 'lucide-react';
import { ALLOWED_TYPES, validateAttachments } from '../utils/supportAttachments';

function Preview({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return undefined;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url
    ? <img src={url} alt="" className="w-8 h-8 rounded object-cover" />
    : <FileText size={16} aria-hidden="true" />;
}

export default function AttachmentInput({ files, onChange }) {
  const { t } = useTranslation();

  const addFiles = (e) => {
    const next = [...files, ...Array.from(e.target.files || [])];
    e.target.value = '';
    const error = validateAttachments(next);
    if (error) toast.error(t(error));
    else onChange(next);
  };

  return (
    <div className="space-y-2">
      <label className="block text-xs text-gray-400">
        {t('support.attachments_hint')}
        <input
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',')}
          onChange={addFiles}
          className="block w-full mt-1 text-sm text-gray-300"
        />
      </label>
      {files.map((file, i) => (
        <div key={`${file.name}-${file.lastModified}-${i}`} className="flex items-center gap-2 text-xs text-gray-300">
          <Preview file={file} />
          <span className="flex-1 truncate">{file.name}</span>
          <button
            type="button"
            aria-label={t('support.remove_file', { name: file.name })}
            onClick={() => onChange(files.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
