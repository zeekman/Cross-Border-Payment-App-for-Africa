import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';

function TransactionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [receiptBusy, setReceiptBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/payments/${id}`)
      .then((res) => {
        if (!cancelled) setTx(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load transaction');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const fetchReceipt = async (format) => {
    const res = await api.get(`/payments/${id}/receipt`, {
      params: { format },
      responseType: 'blob',
      headers: { 'Accept-Language': i18n.language },
    });
    return res.data;
  };

  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownload = async () => {
    setReceiptBusy(true);
    try {
      const blob = await fetchReceipt('pdf');
      triggerDownload(blob, `receipt-${id}.pdf`);
    } catch (err) {
      setError(err?.message || 'Failed to download receipt');
    } finally {
      setReceiptBusy(false);
    }
  };

  const handleShare = async () => {
    setReceiptBusy(true);
    try {
      const blob = await fetchReceipt('png');
      const file = new File([blob], `receipt-${id}.png`, { type: 'image/png' });
      if (
        typeof navigator !== 'undefined' &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file] });
      } else {
        triggerDownload(blob, `receipt-${id}.png`);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || 'Failed to share receipt');
      }
    } finally {
      setReceiptBusy(false);
    }
  };

  if (loading) {
    return <div className="transaction-detail">{t('common.loading')}</div>;
  }

  if (error && !tx) {
    return (
      <div className="transaction-detail">
        <p className="error">{error}</p>
        <button type="button" onClick={() => navigate(-1)}>
          {t('common.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="transaction-detail">
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        {t('common.back')}
      </button>
      <h1>{t('transaction.detailTitle')}</h1>
      {tx && (
        <dl className="transaction-detail__fields">
          <dt>{t('transaction.amount')}</dt>
          <dd>{tx.amount}</dd>
          <dt>{t('transaction.asset')}</dt>
          <dd>{tx.asset}</dd>
          <dt>{t('transaction.recipient')}</dt>
          <dd>{tx.recipient}</dd>
          <dt>{t('transaction.status')}</dt>
          <dd>{tx.status}</dd>
          <dt>{t('transaction.date')}</dt>
          <dd>{tx.createdAt}</dd>
        </dl>
      )}
      <div className="transaction-detail__receipt-actions">
        <button type="button" onClick={handleDownload} disabled={receiptBusy}>
          {t('transaction.downloadReceipt')}
        </button>
        <button type="button" onClick={handleShare} disabled={receiptBusy}>
          {t('transaction.shareReceipt')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default TransactionDetail;
