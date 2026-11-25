import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ShieldCheck,
  Clock,
  XCircle,
  CheckCircle,
  Check,
  User,
  FileText,
  ClipboardCheck,
} from "lucide-react";
import api from "../utils/api";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

// ── Step definitions ──────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: "Personal Info",    shortLabel: "1", Icon: User },
  { id: 2, label: "Document Upload",  shortLabel: "2", Icon: FileText },
  { id: 3, label: "Review & Submit",  shortLabel: "3", Icon: ClipboardCheck },
  { id: 1, label: "kyc.step1",        shortLabel: "1", Icon: User },
  { id: 2, label: "kyc.step2",        shortLabel: "2", Icon: FileText },
  { id: 3, label: "kyc.step3",        shortLabel: "3", Icon: Camera },
  { id: 4, label: "kyc.step4",        shortLabel: "4", Icon: ClipboardCheck },
];

const SESSION_KEY = "afripay_kyc_step";
const DOC_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const DOC_MAX_BYTES = 10 * 1024 * 1024;

function KYCStepIndicator({ currentStep, completedSteps = [], onStepClick }) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('kyc.progress')}
      className="w-full"
    >
      <ol className="flex items-center justify-between gap-1 sm:gap-2">
        {STEPS.map((step, idx) => {
          const isCompleted = completedSteps.includes(step.id);
          const isCurrent   = currentStep === step.id;
          const isFuture    = !isCompleted && !isCurrent;
          const isClickable = isCompleted;

          return (
            <li key={step.id} className="flex-1 flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => isClickable && onStepClick(step.id)}
                disabled={!isClickable}
                tabIndex={0}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`${t('kyc.stepAria', { id: step.id, label: t(step.label) })}${isCompleted ? t('kyc.completed') : isCurrent ? t('kyc.current') : ''}`}
                className={`
                  w-9 h-9 rounded-full flex items-center justify-center border-2 transition-colors
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2
                  ${isCompleted
                    ? "bg-green-500 border-green-500 text-white cursor-pointer hover:bg-green-400"
                    : isCurrent
                    ? "bg-primary-500 border-primary-500 text-white"
                    : "bg-gray-800 border-gray-600 text-gray-500 cursor-default"}
                `}
              >
                {isCompleted ? (
                  <CheckCircle size={16} aria-hidden="true" />
                ) : (
                  <>
                    {/* Mobile: show number only */}
                    <span className="sm:hidden text-xs font-bold">{step.shortLabel}</span>
                    {/* Desktop: show icon */}
                    <step.Icon size={15} aria-hidden="true" className="hidden sm:block" />
                  </>
                )}
              </button>

              {/* Label: hidden on mobile to avoid overflow */}
              <span
                className={`
                  hidden sm:block text-xs text-center leading-tight
                  ${isCurrent ? "text-white font-semibold" : isCompleted ? "text-green-400" : "text-gray-500"}
                `}
              >
                {t(step.label)}
              </span>

              {/* Connector line (except after last step) */}
              {idx < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute hidden`}
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Progress line between steps */}
      <div className="relative mt-1 h-0.5 bg-gray-700 rounded-full mx-4">
        <div
          className="absolute inset-y-0 left-0 bg-primary-500 rounded-full transition-all duration-300"
          style={{ width: `${((currentStep - 1) / (STEPS.length - 1)) * 100}%` }}
        />
      </div>
    </nav>
  );
}

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  verified: {
    icon: CheckCircle,
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/20",
    label: "kyc.verified",
    message: "kyc.verifiedMsg",
  },
  pending: {
    icon: Clock,
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/20",
    label: "kyc.underReview",
    message: "kyc.underReviewMsg",
  },
  rejected: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/20",
    label: "kyc.rejected",
    message: "kyc.rejectedMsg",
  },
  unverified: {
    icon: ShieldCheck,
    color: "text-gray-400",
    bg: "bg-gray-800 border-gray-700",
    label: "kyc.unverified",
    message: "kyc.unverifiedMsg",
  },
};

const ID_TYPES = [
  { value: "national_id",      label: "kyc.idNational" },
  { value: "passport",         label: "kyc.idPassport" },
  { value: "drivers_license",  label: "kyc.idDrivers" },
  { value: "voters_card",      label: "kyc.idVoters" },
];

// ── Main component ────────────────────────────────────────────────────────────
export default function KYCVerification() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [kycStatus,  setKycStatus]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    id_type: "", id_number: "", date_of_birth: "",
    document_file: null, document_expiry_date: "",
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [uploadPct, setUploadPct] = useState(0);

  // Restore step from sessionStorage (persists on refresh)
  const [currentStep, setCurrentStep] = useState(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    return saved ? parseInt(saved, 10) : 1;
  });
  const [completedSteps, setCompletedSteps] = useState(() => {
    const saved = sessionStorage.getItem(`${SESSION_KEY}_completed`);
    return saved ? JSON.parse(saved) : [];
  });

  const persistStep = (step, completed) => {
    sessionStorage.setItem(SESSION_KEY, step);
    sessionStorage.setItem(`${SESSION_KEY}_completed`, JSON.stringify(completed));
  };

  useEffect(() => {
    api
      .get("/kyc/status")
      .then((r) => setKycStatus(r.data.kyc_status))
      .catch(() => setKycStatus("unverified"))
      .finally(() => setLoading(false));
  }, []);

  const goToStep = (step) => {
    setCurrentStep(step);
    persistStep(step, completedSteps);
  };

  const advanceStep = () => {
    const newCompleted = completedSteps.includes(currentStep)
      ? completedSteps
      : [...completedSteps, currentStep];
    const next = currentStep + 1;
    setCompletedSteps(newCompleted);
    setCurrentStep(next);
    persistStep(next, newCompleted);
  };

  const handleDocumentChange = (e) => {
    const file = e.target.files?.[0] ?? null;
    let error;
    if (file && !DOC_TYPES.includes(file.type)) error = "Only JPEG, PNG, or PDF files are allowed";
    else if (file && file.size > DOC_MAX_BYTES) error = "File must be 10 MB or smaller";
    setFieldErrors((prev) => ({ ...prev, document: error }));
    setForm({ ...form, document_file: error ? null : file });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    setUploadPct(0);
    try {
      const body = new FormData();
      body.append("document", form.document_file);
      body.append("id_type", form.id_type);
      body.append("id_number", form.id_number);
      body.append("date_of_birth", form.date_of_birth);
      if (form.document_expiry_date) body.append("document_expiry_date", form.document_expiry_date);
      await api.post("/kyc/submit", body, {
        onUploadProgress: (ev) => {
          if (ev.total) setUploadPct(Math.round((ev.loaded / ev.total) * 100));
        },
      });
      toast.success(t('kyc.submitted'));
      setKycStatus("pending");
      // Clear persisted step state
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(`${SESSION_KEY}_completed`);
    } catch (err) {
      const list = err.response?.data?.errors;
      if (Array.isArray(list) && list.length) {
        const map = {};
        list.forEach((x) => { map[x.path || x.param] = x.msg; });
        setFieldErrors(map);
        toast.error("Please correct the highlighted fields.");
      } else {
        toast.error(err.response?.data?.error || "Submission failed. Please try again.");
      }
      toast.error(err.response?.data?.error || t('kyc.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const showForm   = kycStatus === "unverified" || kycStatus === "rejected";
  const statusConfig = STATUS_CONFIG[kycStatus] || STATUS_CONFIG.unverified;
  const StatusIcon   = statusConfig.icon;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      <button
        onClick={() => navigate(-1)}
        className="text-gray-400 hover:text-white flex items-center gap-1"
      >
        <ArrowLeft size={18} /> {t('kyc.back')}
      </button>

      <div>
        <h2 className="text-2xl font-bold text-white">{t('kyc.title')}</h2>
        <p className="text-gray-400 text-sm mt-1">
          {t('kyc.subtitle')}
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12" role="status" aria-label={t('kyc.loading')}>
          <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Status banner */}
          <div className={`border rounded-xl p-4 flex items-start gap-3 ${statusConfig.bg}`}>
            <StatusIcon size={20} className={`${statusConfig.color} shrink-0 mt-0.5`} />
            <div>
              <p className={`font-semibold text-sm ${statusConfig.color}`}>{t(statusConfig.label)}</p>
              <p className="text-gray-400 text-sm mt-0.5">{t(statusConfig.message)}</p>
            </div>
          </div>

          {showForm && (
            <>
              {/* Step indicator */}
              <KYCStepIndicator
                currentStep={currentStep}
                completedSteps={completedSteps}
                onStepClick={goToStep}
              />

              {/* Step content */}
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Step 1 — Personal Info */}
                {currentStep === 1 && (
                  <>
                    <h3 className="text-white font-semibold">Step 1 of 3 — Personal Info</h3>
                    <div>
                      <label htmlFor="kyc-dob" className="text-sm text-gray-400 mb-1 block">Date of Birth</label>
                    <h3 className="text-white font-semibold">{t('kyc.stepOf', { n: 1, label: t('kyc.step1') })}</h3>
                    <div>
                      <label className="text-sm text-gray-400 mb-1 block">{t('kyc.dob')}</label>
                      <input
                        id="kyc-dob"
                        type="date"
                        required
                        max={new Date().toISOString().split("T")[0]}
                        value={form.date_of_birth}
                        onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors [color-scheme:dark]"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!form.date_of_birth}
                      onClick={advanceStep}
                      className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors"
                    >
                      {t('kyc.continue')}
                    </button>
                  </>
                )}

                {/* Step 2 — Document Upload */}
                {currentStep === 2 && (
                  <>
                    <h3 className="text-white font-semibold">Step 2 of 3 — Document Upload</h3>
                    <h3 className="text-white font-semibold">{t('kyc.stepOf', { n: 2, label: t('kyc.step2') })}</h3>
                    <div>
                      <label className="text-sm text-gray-400 mb-1 block">{t('kyc.idType')}</label>
                      <select
                        required
                        value={form.id_type}
                        onChange={(e) => setForm({ ...form, id_type: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors"
                      >
                        <option value="" disabled>{t('kyc.selectIdType')}</option>
                        {ID_TYPES.map((idt) => (
                          <option key={idt.value} value={idt.value}>{t(idt.label)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-sm text-gray-400 mb-1 block">{t('kyc.idNumber')}</label>
                      <input
                        type="text"
                        required
                        placeholder={t('kyc.idNumberPlaceholder')}
                        value={form.id_number}
                        onChange={(e) => setForm({ ...form, id_number: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
                      />
                    </div>
                    <div>
                      <label htmlFor="kyc-document" className="text-sm text-gray-400 mb-1 block">ID Document (JPEG, PNG or PDF, max 10 MB)</label>
                      <input
                        id="kyc-document"
                        type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        onChange={handleDocumentChange}
                        className="w-full text-sm text-gray-300"
                      />
                      {form.document_file && (
                        <p className="text-green-400 text-xs mt-1">✓ {form.document_file.name}</p>
                    <button
                      type="button"
                      disabled={!form.id_type || !form.id_number}
                      onClick={advanceStep}
                      className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors"
                    >
                      {t('kyc.continue')}
                    </button>
                  </>
                )}

                {/* Step 3 — Selfie Capture */}
                {currentStep === 3 && (
                  <>
                    <h3 className="text-white font-semibold">{t('kyc.stepOf', { n: 3, label: t('kyc.step3') })}</h3>
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center text-gray-400 text-sm space-y-3">
                      <Camera size={32} className="mx-auto text-primary-400" />
                      <p>{t('kyc.selfieHint')}</p>
                      <label className="inline-block cursor-pointer bg-primary-500/20 hover:bg-primary-500/30 text-primary-300 px-4 py-2 rounded-lg text-sm transition-colors">
                        {t('kyc.uploadSelfie')}
                        <input
                          type="file"
                          accept="image/*"
                          capture="user"
                          className="sr-only"
                          onChange={(e) => setForm({ ...form, selfie_file: e.target.files?.[0] ?? null })}
                        />
                      </label>
                      {form.selfie_file && (
                        <p className="text-green-400 text-xs">✓ {form.selfie_file.name}</p>
                      )}
                      {fieldErrors.document && <p role="alert" className="text-red-400 text-xs mt-1">{fieldErrors.document}</p>}
                    </div>
                    <div>
                      <label htmlFor="kyc-doc-expiry" className="text-sm text-gray-400 mb-1 block">Document Expiry Date</label>
                      <input
                        id="kyc-doc-expiry"
                        type="date"
                        value={form.document_expiry_date}
                        onChange={(e) => setForm({ ...form, document_expiry_date: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors [color-scheme:dark]"
                      />
                      {fieldErrors.document_expiry_date && <p role="alert" className="text-red-400 text-xs mt-1">{fieldErrors.document_expiry_date}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={!form.id_type || !form.id_number || !form.document_file}
                      onClick={advanceStep}
                      className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors"
                    >
                      {t('kyc.continue')}
                    </button>
                  </>
                )}

                {/* Step 3 — Review & Submit */}
                {currentStep === 3 && (
                  <>
                    <h3 className="text-white font-semibold">Step 3 of 3 — Review &amp; Submit</h3>
                    <h3 className="text-white font-semibold">{t('kyc.stepOf', { n: 4, label: t('kyc.step4') })}</h3>
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">{t('kyc.dob')}</span>
                        <span className="text-white">{form.date_of_birth || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">{t('kyc.idType')}</span>
                        <span className="text-white">
                          {ID_TYPES.find((idt) => idt.value === form.id_type) ? t(ID_TYPES.find((idt) => idt.value === form.id_type).label) : "—"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">{t('kyc.idNumber')}</span>
                        <span className="text-white">{form.id_number || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Document</span>
                        <span className="text-white">{form.document_file?.name || "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Expiry Date</span>
                        <span className="text-white">{form.document_expiry_date || "—"}</span>
                      </div>
                      {["id_type", "id_number", "date_of_birth"].map((f) => fieldErrors[f] && (
                        <p key={f} role="alert" className="text-red-400 text-xs">{fieldErrors[f]}</p>
                      ))}
                    </div>
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
                      <p className="text-xs text-gray-400 leading-relaxed">
                        {t('kyc.disclaimer')}
                      </p>
                    </div>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
                    >
                      {submitting && uploadPct > 0 && <span className="text-xs">{uploadPct}%</span>}
                      {submitting ? (
                        <div
                          className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"
                          role="status"
                          aria-label={t('kyc.loading')}
                        />
                      ) : (
                        <><ShieldCheck size={18} /> {t('kyc.submit')}</>
                      )}
                    </button>
                  </>
                )}
              </form>
            </>
          )}
        </>
      )}
    </div>
  );
}
