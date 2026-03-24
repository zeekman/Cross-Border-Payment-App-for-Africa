import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldCheck, Clock, XCircle, CheckCircle } from "lucide-react";
import api from "../utils/api";
import toast from "react-hot-toast";

const ID_TYPES = [
  { value: "national_id", label: "National ID Card" },
  { value: "passport", label: "International Passport" },
  { value: "drivers_license", label: "Driver's License" },
  { value: "voters_card", label: "Voter's Card" },
];

const STATUS_CONFIG = {
  verified: {
    icon: CheckCircle,
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/20",
    label: "Verified",
    message: "Your identity has been verified. You can send transactions of any amount.",
  },
  pending: {
    icon: Clock,
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/20",
    label: "Under Review",
    message:
      "Your KYC submission is being reviewed. This usually takes 1-2 business days.",
  },
  rejected: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/20",
    label: "Rejected",
    message:
      "Your previous submission was rejected. Please resubmit with accurate information.",
  },
  unverified: {
    icon: ShieldCheck,
    color: "text-gray-400",
    bg: "bg-gray-800 border-gray-700",
    label: "Not Verified",
    message: "Verify your identity to send transactions above $100 USD equivalent.",
  },
};

export default function KYCVerification() {
  const navigate = useNavigate();
  const [kycStatus, setKycStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ id_type: "", id_number: "", date_of_birth: "" });

  useEffect(() => {
    api
      .get("/kyc/status")
      .then((r) => setKycStatus(r.data.kyc_status))
      .catch(() => setKycStatus("unverified"))
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post("/kyc/submit", form);
      toast.success(
        "KYC submitted successfully. We will review your application shortly.",
      );
      setKycStatus("pending");
    } catch (err) {
      toast.error(err.response?.data?.error || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const showForm = kycStatus === "unverified" || kycStatus === "rejected";
  const statusConfig = STATUS_CONFIG[kycStatus] || STATUS_CONFIG.unverified;
  const StatusIcon = statusConfig.icon;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      <button
        onClick={() => navigate(-1)}
        className="text-gray-400 hover:text-white flex items-center gap-1"
      >
        <ArrowLeft size={18} /> Back
      </button>

      <div>
        <h2 className="text-2xl font-bold text-white">Identity Verification</h2>
        <p className="text-gray-400 text-sm mt-1">
          Required for regulatory compliance in African markets.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Status banner */}
          <div
            className={`border rounded-xl p-4 flex items-start gap-3 ${statusConfig.bg}`}
          >
            <StatusIcon size={20} className={`${statusConfig.color} shrink-0 mt-0.5`} />
            <div>
              <p className={`font-semibold text-sm ${statusConfig.color}`}>
                {statusConfig.label}
              </p>
              <p className="text-gray-400 text-sm mt-0.5">{statusConfig.message}</p>
            </div>
          </div>

          {/* Submission form */}
          {showForm && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-1 block">ID Type</label>
                <select
                  required
                  value={form.id_type}
                  onChange={(e) => setForm({ ...form, id_type: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors"
                >
                  <option value="" disabled>
                    Select ID type
                  </option>
                  {ID_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-1 block">ID Number</label>
                <input
                  type="text"
                  required
                  placeholder="Enter your ID number"
                  value={form.id_number}
                  onChange={(e) => setForm({ ...form, id_number: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
                />
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-1 block">Date of Birth</label>
                <input
                  type="date"
                  required
                  max={new Date().toISOString().split("T")[0]}
                  value={form.date_of_birth}
                  onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors [color-scheme:dark]"
                />
              </div>

              <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
                <p className="text-xs text-gray-400 leading-relaxed">
                  Your information is used solely for identity verification as required by
                  financial regulations. Raw ID documents are never stored in our
                  database.
                </p>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                {submitting ? (
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <ShieldCheck size={18} /> Submit for Verification
                  </>
                )}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
