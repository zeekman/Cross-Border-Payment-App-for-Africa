import * as Sentry from '@sentry/react';
import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { withTranslation } from 'react-i18next';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, eventId: null, feedbackText: '', feedbackSubmitting: false, feedbackSubmitted: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    const eventId = Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    });
    this.setState({ eventId });
  }

  handleFeedbackChange = (e) => {
    this.setState({ feedbackText: e.target.value });
  };

  handleFeedbackSubmit = async () => {
    const { eventId, feedbackText } = this.state;
    if (!eventId || !feedbackText.trim()) {
      this.setState({ feedbackSubmitted: true });
      return;
    }
    this.setState({ feedbackSubmitting: true });
    try {
      Sentry.captureUserFeedback({
        event_id: eventId,
        comments: feedbackText.trim(),
      });
      this.setState({ feedbackSubmitted: true });
    } catch {
      this.setState({ feedbackSubmitted: true });
    } finally {
      this.setState({ feedbackSubmitting: false });
    }
  };

  handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const { feedbackSubmitted, feedbackSubmitting, feedbackText } = this.state;
      const { t } = this.props;
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white p-4">
          <div className="max-w-md w-full text-center">
            <h1 className="text-2xl font-bold mb-2">{t('shared.somethingWrong', 'Something went wrong.')}</h1>
            <p className="text-gray-400 mb-6">{t('shared.unexpectedError', 'An unexpected error occurred. Our team has been notified.')}</p>

            {feedbackSubmitted ? (
              <div className="bg-gray-900 rounded-2xl p-6">
                <p className="text-primary-400 font-semibold">{t('shared.thankYou', 'Thank you for your feedback!')}</p>
                <p className="text-gray-400 text-sm mt-1">{t('shared.thankYouSub', 'Your report helps us improve AfriPay.')}</p>
                <button
                  onClick={this.handleRefresh}
                  className="mt-4 bg-primary-500 hover:bg-primary-600 text-white font-semibold py-2.5 px-6 rounded-xl text-sm transition-colors"
                >
                  {t('shared.refresh', 'Refresh Page')}
                </button>
              </div>
            ) : (
              <div className="bg-gray-900 rounded-2xl p-6 text-left">
                <label htmlFor="feedback-textarea" className="text-sm text-gray-400 font-medium">
                  {t('shared.feedbackLabel', 'What were you doing when this happened? (optional)')}
                </label>
                <textarea
                  id="feedback-textarea"
                  value={feedbackText}
                  onChange={this.handleFeedbackChange}
                  placeholder={t('shared.feedbackPlaceholder', 'Describe what led to this error...')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 mt-2 resize-none"
                  rows={3}
                  maxLength={500}
                />
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={this.handleRefresh}
                    className="flex-1 py-2.5 rounded-xl bg-gray-800 text-gray-400 text-sm hover:text-white transition-colors"
                  >
                    {t('shared.refresh', 'Refresh Page')}
                  </button>
                  <button
                    onClick={this.handleFeedbackSubmit}
                    disabled={feedbackSubmitting}
                    className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
                  >
                    {feedbackSubmitting ? t('shared.sending', 'Sending...') : t('shared.sendReport', 'Send Report')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    return <ErrorBoundaryWrapper>{this.props.children}</ErrorBoundaryWrapper>;
  }
}

// Wrapper component to handle route changes and reset error boundary
function ErrorBoundaryWrapper({ children }) {
  const location = useLocation();

  useEffect(() => {
    // Reset error boundary when route changes
    // This is handled by the key prop on the ErrorBoundary in App.jsx
  }, [location]);

  return children;
}

export default withTranslation()(ErrorBoundary);